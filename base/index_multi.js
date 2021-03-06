var cluster = require("cluster");
var path = require("path");
var ExBuffer = require('./buffer');
var log = require("./log");
var db = require("./db").DBProvider;


var _relative = path.relative(process.cwd(),process.argv[1]);
var _relative_log = path.dirname(_relative) + "/server.log";
process.chdir(path.dirname(process.argv[1]));

var config = require("./config");
config.init();

exports.start_server = function(h)
{
	var cb = void 0;
	var obj = void 0;

	if(typeof h ==="function")
	{
		cb = h;
	}
	else
	{
		if(typeof h ==="object")
		{
			obj = h;
		}

		if(arguments.length >1 && typeof arguments[1] === "function")
		{
			cb = arguments[1];
		}
	}

	var s = new server();
	s.start_server(obj,cb);
	return s;
};

function server(){};

server.prototype.start_server = function(obj,cb)
{
	var self = this;
	var conf = config.conf;

	if(conf.test == 1)
	{
        log.init(conf.test);
        new db(conf,self,function(s){
            start(s);
        });
	}
	else
	{
		if(cluster.isMaster)
		{
			if(require("tty").isatty(1))
			{
				console.log("must start server use this command : \n");
				process.exit(1);
            }

            cluster.fork();

            cluster.on('disconnect',function(worker)
            {
                global.log("worker " + worker.process.pid  + " died, restart...");
                global.log("totalmem:"+require('os').totalmem());
                global.log("freemem:"+require('os').freemem());
                global.log('This process is pid ' + process.pid);
                global.log(require('util').inspect(process.memoryUsage()));
                global.log(process.memoryUsage().rss/require('os').totalmem());
                cluster.fork();
            });
		}
		else
		{
            log.init(conf.test);
            new db(conf,self,function(s){
                start(s);
            });
		}
	}


	function start(s)
	{
		var net = require("net");
		var compressor = require("./compressor");
        var cry_pto=compressor.crypto();
        var domain = require('domain');

        var socket_server,is_ok_socket=1;


		self = s;
        self.config = conf;
        process.on("uncaughtException",function(err){
            global.err("catch exception:" + err.stack);
        });

		if(conf.dynamic == 1)
		{
			var _util = require("./util");

			var _fs= require("fs");
			self.dynamic = {};
			function check_dynamic()
			{
				config.initasync("./dynamic.ini",function(err,dynamicconf){
					if(err)
					{
						global.log("read dynamic.ini failed : "+ err);
					}
					else
					{
						_util.extend(self.dynamic,dynamicconf);
						global.log("self.dynamic:"+JSON.stringify(self.dynamic));
                        if(self.dynamic.stop==1&&is_ok_socket)
                        {
                            is_ok_socket=0;
                            global.log("server is closing!");
                            socket_server.emit("exit");
                        }
					}
				});
			}

            check_dynamic();

			function set_watch(){
				_fs.watch("./dynamic.ini",function(event,filename){
					if(event ==="change")
					{
                        check_dynamic();
					}
				})
			}
            set_watch();
		}
		if(obj)
		{
			for(var key in obj)
			{
				(function(k){
					var info = obj[k];
					var serverinfo = conf[k];
					if(typeof info.handler === "object")
					{
						if(info.is_server == 1)
						{
							socket_server = net.createServer(function(c){
                                var d = domain.create();
                                d.on('error', function (err) {

                                    global.err("catch domain exception:" + err.stack);
                                    var err_msg = {
                                        "op" : c.op,
                                        "ret" : 42
                                    };
                                    c.send(err_msg);
                                    c.destroy();

                                });
                                d.add(c);

                                c.c_ip= c.remoteAddress;
                                c.c_port= c.remotePort;

                                //客户端默认是65秒发一次心跳,一般情况下2分钟左右比较好
								c.setTimeout(1*70*1000);
								c.addListener("timeout",function(){
                                    global.log("socket timeout,ip:"+c.c_ip+",port:"+ c.c_port);
									c.destroy();
								});

								var exBuffer = new ExBuffer().uint32Head().littleEndian();
								exBuffer.on('data',onReceivePackData);

                                if(info.zip==1)
                                {
                                    c.send=function(msg){
                                        var cdata = JSON.stringify(msg);
                                        var len = Buffer.byteLength(cdata);
                                        //global.log("send data length:"+len);
                                        if(len>3*1024)
                                        {
                                            //var date1=new Date().getTime();
                                            cry_pto.encode(cdata,function(err,buffer){
                                                if(!err)
                                                {
                                                    //global.log("date_diff:"+((new Date().getTime())-date1));
                                                    len =buffer.length ;
                                                    //global.log("len2:"+len);
                                                    //写入4个字节表示本次包长
                                                    var headBuf = new Buffer(4);
                                                    headBuf.writeUInt32LE(len, 0);
                                                    //写入4个字节表示是否压缩
                                                    var markBuf = new Buffer(4);
                                                    markBuf.writeUInt32LE(1, 0);

                                                    var bodyBuf = new Buffer(headBuf.length+markBuf.length+len);
                                                    headBuf.copy(bodyBuf,0,0,headBuf.length);
                                                    markBuf.copy(bodyBuf,headBuf.length,0,markBuf.length);
                                                    buffer.copy(bodyBuf,headBuf.length+markBuf.length);
                                                    c.write(bodyBuf);
                                                }
                                            });
                                        }
                                        else{
                                            //写入4个字节表示本次包长
                                            var headBuf = new Buffer(4);
                                            headBuf.writeUInt32LE(len, 0);

                                            var markBuf = new Buffer(4);
                                            markBuf.writeUInt32LE(0, 0);

                                            var bodyBuf = new Buffer(headBuf.length+markBuf.length+len);
                                            headBuf.copy(bodyBuf,0,0,headBuf.length);

                                            markBuf.copy(bodyBuf,headBuf.length,0,markBuf.length);

                                            bodyBuf.write(cdata,headBuf.length+markBuf.length);
                                            c.write(bodyBuf);
                                        }
                                    }
                                }
                                else
                                {
                                    c.send=function(msg){
                                        msg = JSON.stringify(msg);
                                        var len = Buffer.byteLength(msg);

                                        //写入4个字节表示本次包长
                                        var headBuf = new Buffer(4);
                                        headBuf.writeUInt32LE(len, 0);

                                        var bodyBuf = new Buffer(len+headBuf.length);
                                        headBuf.copy(bodyBuf,0,0,headBuf.length);
                                        bodyBuf.write(msg,headBuf.length);
                                        c.write(bodyBuf);

                                    }
                                }


								//当服务端收到完整的包时
								function onReceivePackData(buffer){
                                    var receive_data=buffer.toString();
                                    global.log("receive data:"+receive_data);
                                    try
                                    {
                                        receive_data = JSON.parse(receive_data);
                                    }
                                    catch(err)
                                    {
                                        global.log("parse receive_data : " + err.stack);
                                        var err_msg = {
                                            "op" : c.op,
                                            "ret" : 42
                                        };
                                        c.send(err_msg);
                                        c.destroy();
                                        return;
                                    }

                                    c.op=receive_data.op;
                                    if(info.handler[receive_data.op])
                                    {
                                        d.run(function(){
                                            info.handler[receive_data.op].handle(receive_data, c.send,c);
                                        });
                                    }
                                    else
                                    {
                                        global.log("error,can not handle msg !");
                                        var err_msg = {
                                            "op" : c.op,
                                            "ret" : 42
                                        };
                                        c.send(err_msg);
                                        c.destroy();
                                    }
								}

								c.on("data",function(data){
									exBuffer.put(data);//只要收到数据就往ExBuffer里面put
								});

								c.on("error",function(e){
									global.err("socket err :" + e);
                                    c.destroy();
								});

								if(info.handler["___close___"])
								{
									c.on("close",function(e){
										info.handler["___close___"].handle(c);
									});
								}

								if(info.handler["___connect___"])
								{
									info.handler["___connect___"].handle(c);
								}
							});

                            setInterval(function(){socket_server.getConnections(function(err,count){
                                if(!err){global.log("server_count:"+count );}
                            })},10*60*1000);

                            socket_server.listen(serverinfo.serverport,function(){
								global.log("listen on port: " + serverinfo.serverport + " ok!");
							});
						}
						else
						{
							global.log("connecting to server : " + serverinfo.serverip +  "[" + serverinfo.serverport + "]");
							(function connectserver(){
								var client = net.connect(serverinfo.serverport,serverinfo.serverip,function(){

									var exBuffer = new ExBuffer().uint32Head().littleEndian();
									exBuffer.on('data',onReceivePackData);

									//当客户端收到完整的包时
									function onReceivePackData(buffer){
                                        var receive_data=buffer.toString();
                                        global.log("receive data:"+receive_data);
                                        try
                                        {
                                            receive_data = JSON.parse(receive_data);
                                        }
                                        catch(err)
                                        {
                                            global.log("parse receive_data : " + err);

                                            client.emit("close");

                                            return;
                                        }

                                        if(info.handler[receive_data.op])
                                        {
                                            info.handler[receive_data.op].handle(receive_data, client.send,client);
                                        }
                                        else
                                        {
                                            global.err("can not handle msg !");
                                        }
									}

									client.send=function(msg){
										msg = JSON.stringify(msg);
										var len = Buffer.byteLength(msg);
										/*
										 * 单次写入
										 *
										var headBuf = new Buffer(4);
										headBuf.writeUInt32LE(len, 0);
										c.write(headBuf);

										var bodyBuf = new Buffer(len);
										bodyBuf.write(msg);
										c.write(bodyBuf);
										*/
										//写入4个字节表示本次包长
										var headBuf = new Buffer(4);
										headBuf.writeUInt32LE(len, 0);
										//socket.write(headBuf);

										var bodyBuf = new Buffer(len+headBuf.length);
										headBuf.copy(bodyBuf,0,0,headBuf.length);
										bodyBuf.write(msg,headBuf.length);
										client.write(bodyBuf);

									};
									client.on("data",function(data){
										exBuffer.put(data);//只要收到数据就往ExBuffer里面put
									});
									//client.ondata = msg.readmsg(client,handler.handlermsg(info.handler),crypto.crypto(serverinfo.crypto),exBuffer);

									client.on("error",function(e){
										global.err("socket err : " + e);
									});
									if(info.retry === 1)
									{
										client.on("close",function(e){
											global.log("reconnection to server : " + serverinfo.serverip + "[" + serverinfo.serverport+"]");
											connectserver();
										});
									}
									if(info.handler["___close___"])
									{
										client.on("close",function(e){
											info.handler["___close___"].handle(client);
										});
									}
									if(info.handler["___connect___"])
									{
										info.handler["___connect___"].handle(client);
									}
								})
							})();
						}
					}
				})(key);
			}
		}
		else
		{
			global.log("-- start no handler server -- ");
		}

		if(conf.http)
		{
			self.http = require("./http").initserver(conf.http);
		}
        if(socket_server)
        {
            self.socket_server = socket_server;
        }

		if(cb)
		{
			cb(self);
		}
	}
};