var http         = require("http");          //required to host server
var fs           = require("fs");            //required to send files
var express      = require("express");       //required for requests 
var bodyParser   = require("body-parser");   //required for reading requests
var AWS          = require("aws-sdk");       //required for AWS Services
var cookieParser = require("cookie-parser"); //required for reading cookies

//setup express to read/write JSON post/get reqs
var app          = express();
app.use(bodyParser.urlencoded({extended:true}));
app.use(bodyParser.json());
app.use(cookieParser());

/* Dead code for socket.io if we want a constant connection
var io = require("socket.io")(http);
io.on("connection",function(socket){
  console.log("new connection");
  io.emit("hello");
});
*/

var ERROR = {};
ERROR.badRequest = 400;
ERROR.unauthorized = 401;
ERROR.forbidden = 403;
ERROR.notFound = 404;
ERROR.timeout = 408;
ERROR.tooManyRequests = 429;
ERROR.serverError = 500;
ERROR.serviceUnavailable = 503;
ERROR.gatewayTimeout = 504;
var SUCCESS = {};
SUCCESS.okay = 200;
SUCCESS.created = 201;
SUCCESS.accepted = 202;
SUCCESS.noContent = 204;

/* load credentials */
var thingName = "AquaOS", tableName = "TempWatch", passtableName = "Users";
var dynamoDB,IotData,Robert;
fs.readFile("credentials","utf8",function(err,data){
  if(err){
    console.log(err);
    res.status(ERROR.serverError).send({error:"server not configured with account credentials"});
  }else{
    lines=data.split("\n");
    creds = new AWS.Credentials(lines[0],lines[1]);
    myConfig = new AWS.Config();
    myConfig.update({region:lines[2],credentials:creds});
    dynamoDB = new AWS.DynamoDB(myConfig);
    IotData = new AWS.IotData({credentials:creds,endpoint:lines[3],region:lines[2]});
    
    rcreds = new AWS.Credentials(lines[4],lines[5]);
    Robert = new AWS.IotData({credentials:rcreds,endpoint:lines[6],region:lines[2]});
    delete(lines);delete(myConfig);delete(creds);delete(rcreds);
/* Take a look at the state of DynamoDB */
dynamoDB.listTables({},function(err,data){
  if(err){
    console.log(error);
    console.log("TLDR: can't connect to AWS DynamoDB.");
    process.exit(1);
  }else{
    tables = data.TableNames;
    tables.sort(); //alphabetic ordering
    if(tables.indexOf(passtableName) >= 0){ //no users exist.
      console.log("Fresh start.");
    }else{
      console.log((tables.length-1) + " users exist");

      query = {TableName:passtableName,ExpressionAttributeNames:{"#TS":"timestamp"},ProjectionExpression:"username,#TS"};
      dynamoDB.scan(query,function(err,data){
        if(err) console.log(err);
        else{
          curdate = parseDate(getDateStr());
          for(i=0;i<data.Count;i++){
            username = data.Items[i].username.S;
            lastAccessed = parseDate(data.Items[i].timestamp.S);
            console.log(dateDif(lastAccessed,curdate));
            console.log(curdate);console.log(lastAccessed);
            if(dateDif(lastAccessed,curdate) >= 3600*24*7){ //no access in the past week
              dynamoDB.deleteItem({TableName:passtableName,Key:{username:{S:username}}},function(err,data){console.log(err? err : data);});
            }
          }
          console.log(data.Items[0]);
        }
      });
    }
  }
});
/* END DYNAMODB CONFIG */
}});


var DISABLE_LOGIN = true;
app.use(function(req,res,next){
  if(DISABLE_LOGIN ||
     (req.url=="/login" || req.url=="/newUser") ||
     (req.cookies && req.cookies.token)) next();
  else res.status(ERROR.forbidden).redirect("/login");
});
app.get("/login",function(req,res){
  fs.readFile("login.html",function(err,data){
    res.send(data.toString());
  });
});
app.post("/login",function(req,res){
  user=req.body.username;
  pswd=req.body.password;
  
  dynamoDB.getItem({TableName:passtableName,Key:{"username":{S:user}}},function(err,data){
    if(err) res.status(ERROR.serverError).send({error:err});
    else if(!data.Item || pswd != data.Item.password.S){
      res.status(ERROR.unauthorized).send({error:"invalid username or password."});
    }else{
      console.log("logging in...");
      signedon=true;
      cookie = {username:user,token:pswd};
      res.cookie("info",{username:user,token:pswd});
      res.status(SUCCESS.accepted).send({location:"/",cookie:cookie});
    }
  });
});
app.post("/newUser",function(req,res){
  var params = req.body;
  if(!params.password || !params.username){
    res.status(ERROR.badRequest).send({error:"Your request is invalid."});
  }else{
    dynamoDB.getItem({TableName:passtableName,Key:{"username":{S:params.username}}},function(err,data){
      if(err){
        res.status(ERROR.notFound).send(err);
        console.log(err);
      }else if(data.Item){
        res.status(ERROR.badRequest).send({error:"Error - user already exists"});
      }else{
        newuser = {username:{S:params.username},
                   password:{S:params.password},
                   token:{S:params.password},
                   lastAccess:{S:getDateStr()}};
        dynamoDB.putItem({TableName:passtableName,Item:newuser},function(err,data){
          if(err){
            res.status(ERROR.serverError).send(err);
            console.log(err);
          }else{
            cookie = {username:params.username,token:params.password};
            res.cookie("info",cookie,{maxAge:3600*1000});
            res.status(SUCCESS.created).send({location:"/",cookie:cookie,maxAge:3600*1000});
          }
        });
      }
    });
  }
});
app.get("/newUser",function(req,res){
  fs.readFile("NewUser.html",function(err,data){
    res.send(data.toString());
  });
});
app.get("/",function(req,res){
  fs.readFile("index.html",function(err,data){
    res.send(data.toString());
  });
});



app.post("/reset",function(req,res){
  console.log("WARNING: restarting table will take about 35 seconds.");
  dynamoDB.deleteTable({TableName:tableName},function(err,data){
    console.log("deleting table...");
    dynamoDB.waitFor("tableNotExists",{TableName:tableName},function(err,data){
      if(err) console.log(err);
      else{
        console.log("table deleted! recreating table...");
        createTable();
        dynamoDB.waitFor("tableExists",{TableName:tableName},function(err,data){
          if(err) console.log(err);
          else{
            console.log("table recreated!");
            res.send("{}");
          }
        });
      }
    });
  });
});

app.get("/rshadow",function(req,res){
  console.log("rshadow requested.");
  Robert.getThingShadow({thingName:"SeaSea"},function(err,data){
    if(err){
      console.log(err);
      res.send("ERROR");
    }else{
      msg = JSON.parse(data.payload);
      msg = msg.state.reported;
      res.send(msg || {});
    }
  });
});

app.post("/rshadow",function(req,res){
  var state = req.body.state || "desired";
  delete(req.body.state);
  params = req.body;

  updatestr = {"state":{}};
  updatestr.state[state] = params;
  console.log(updatestr);
  Robert.updateThingShadow({thingName:"SeaSea",payload:JSON.stringify(updatestr)},function(err,data){
    if(err){
      console.log(err);
      res.status(400);
      res.send("Error.");
    }else{
      res.send("Success.");
    }
  });
});

app.get("/shadow",function(req,res){
  console.log("Shadow requested.");
  IotData.getThingShadow({thingName:"AquaOS"},function(err,data){
    if(err){
      console.log(err);
      res.send("ERROR");
    }else{
      msg = JSON.parse(data.payload);
      msg = msg.state.desired;
      res.send(msg || {});
    }
  });
});

app.post("/shadow",function(req,res){
  var state = req.body.state || "desired";
  delete(req.body.state);
  params = req.body;

  updatestr = {"state":{}};
  updatestr.state[state] = params;
  console.log(updatestr);
  IotData.updateThingShadow({thingName:thingName,payload:JSON.stringify(updatestr)},function(err,data){
    if(err){
      console.log(err);
      res.status(400);
      res.send("Error.");
    }else{
      res.send("Success.");
    }
  });
});

app.post("/lambda",function(req,res){
  console.log("Heard lambda!!");
  console.log(JSON.stringify(req.body));
  res.send("ack");
});

var commands=[];
app.get("/commands",function(req,res){
  console.log("Requesting commands.");
  res.send(commands);
});
app.post("/commands",function(req,res){
  if(req.body.reset) commands = [];
  if(req.body.command) commands.push(req.body.command);
});

app.post("/elem",function(req,res){
  var newdata = req.body.newdata;
  var time = getDateStr();
  dynamoDB.waitFor("tableExists",{TableName:tableName},function(err,data){
    item = {"Timestamp":{"S":time}};
    for(i=1;i<=PARAMS.data.length;i++){
      if(i==PARAMS.data.length) param = {name:"type",type:"S"};
      else param = PARAMS.data[i];
      name = param.name;
      type = param.type;
      val = {};
      val[type] = ""+newdata[name];
      item[name] = val;
      console.log(val);
    }
    dynamoDB.putItem({Item:item,TableName:tableName,ReturnConsumedCapacity:"TOTAL"},function(err,data){
      if(err) console.log(err);
      else console.log("posted!");
    });
  });
});

app.post("/fish",function(req,res){
  var newdata = req.body;
  var time = getDateStr();
  dynamoDB.waitFor("tableExists",{TableName:tableName},function(err,data){
    item = {"Timestamp":{"S":time},"type":{"S":"fish"}};
    for(i=1;i<PARAMS.fish.length;i++){
      param = PARAMS.fish[i];
      name = param.name;
      type = param.type;
      val = {};
      val[type] = ""+newdata[name];
      item[name] = val;
      console.log(val);
    }
    if(newdata.add==undefined || newdata.add){
      dynamoDB.putItem({Item:item,TableName:tableName,ReturnConsumedCapacity:"TOTAL"},function(err,data){
        if(err) res.send(err);
        else res.send("Done!");
      });
    }else{
      getData("fish",undefined,undefined,undefined,function(data){
        targetFish = undefined;
        for(idx in data){
          fish = data[idx];
          console.log(fish);
          if(fish.id === newdata.id){
            targetFish = data[idx];
            break;
          }
        }
        if(targetFish){
          dynamoDB.deleteItem({TableName:tableName,Key:{Timestamp:{S:targetFish.Timestamp}}},
                                function(err,data){
                                  if(err){
                                  console.log(err);
                                  res.send(err);
                                  }else res.send("Finished.");
                                });
        }else res.send("failed.");
      });
    }
  });
});

app.get("/fish",function(req,res){
  console.log("fish requested");
  type = "fish";
  //first make sure table exists
  dynamoDB.waitFor("tableExists",{TableName:tableName},function(err,data){
    //get values
    dynamoDB.scan({TableName:tableName}, function(err, data) {
      if (err) res.send(err); // an error occurred
      else{
        //simplify data
        dataItems = data.Items;
        var values = new Array();
        for(i=0;i<data.Items.length;i++){
          item = data.Items[i];
          if(item.type == undefined){
            console.log(item);
            continue;
          }
          if(item.type.S != type) continue;
          pushitem = {};
          for(j=0;j<PARAMS[type].length;j++){
            name=PARAMS[type][j].name;
            datatype=PARAMS[type][j].type;
            val = item[name][datatype];
            if(datatype == "N") val = parseInt(val);
            pushitem[name] = val;
          }
          values.push(pushitem);
        }
         
        //sort data. First item val always guaranteed to be Timestamp
        for(i=0;i<values.length;i++){
          newmin = values[i].Timestamp;
          newidx = i;
          for(j=i+1;j<values.length;j++){
            if(values[j].Timestamp < newmin){
              newmin = values[j].Timestamp;
              newidx = j;
            }
          }
          savedval = values[i];
          values[i] = values[newidx];
          values[newidx] = savedval;
        }
        console.log("fish are: "+JSON.stringify(values));
        res.send(values);
      }
    });
  });
});

app.post("/data",function(req,res){
  console.log("Database info requested.");
  type = "data";
  lower = req.body.lower;
  upper = req.body.upper;
  console.log(lower+","+upper);
  getData(type,lower,upper,res,undefined);
});

function getData(type,lower,upper,res,callback){
  //first make sure table exists
  dynamoDB.waitFor("tableExists",{TableName:tableName},function(err,data){
    //get values
    dynamoDB.scan({TableName:tableName}, function(err, data) {
      if (err){
        if(res) res.send(err); // an error occurred
        console.log(err);
      }else{
        //simplify data
        dataItems = data.Items;
        var values = new Array();
        for(i=0;i<data.Items.length;i++){
          item = data.Items[i];
          if(item.type.S != type) continue;
          pushitem = {};
          for(j=0;j<PARAMS[type].length;j++){
            name=PARAMS[type][j].name;
            datatype=PARAMS[type][j].type;
            val = item[name][datatype];
            if(datatype == "N") val = parseInt(val);
            pushitem[name] = val;
          }
          values.push(pushitem);
        }
         
        //sort data. First item val always guaranteed to be Timestamp
        for(i=0;i<values.length;i++){
          newmin = values[i].Timestamp;
          newidx = i;
          for(j=i+1;j<values.length;j++){
            if(values[j].Timestamp < newmin){
              newmin = values[j].Timestamp;
              newidx = j;
            }
          }
          savedval = values[i];
          values[i] = values[newidx];
          values[newidx] = savedval;
        }
              
        //filter results by Timestamp            
        values = values.map(function(value,index){
          time = value.Timestamp;
          if((lower==undefined && upper==undefined) ||
             (lower!=undefined && upper!=undefined && inRange(time,lower,upper))) return value;
          else if(lower!=undefined && upper==undefined && inRange(time,lower,time)) return value;
          else if(upper!=undefined && lower==undefined && inRange(time,time,upper)) return value;
          else return NaN; //not within time frame
        });
        values = values.filter(function(val){ return val;});
        if(res) res.send(values); //gets rid of NaNs
        if(callback) callback(values);
      }
    });
  });
}


/*
app.get("/schedule",function(req,res){
  var user = "admin";//req.cookies.info.username
  dynamoDB.getItem({TableName:passtableName,Key:{"username":{S:user}}},function(err,data){
    if(err){
      console.log(err);
      res.send("Invalid request.");
    }else{
      console.log(data.Item.schedule.S);
      res.send({"schedule":JSON.parse(data.Item.schedule.S)});
    }
  });
});

app.post("/schedule",function(req,res){
  schedule = req.body.schedule;
  console.log(schedule);
  var user = "admin";//req.cookies.info.username || "admin";
  var params = {TableName: passtableName,
               Key:{"username":{S:user}},
               ExpressionAttributeValues:{":s":{S:JSON.stringify(schedule)}},
               UpdateExpression: "SET schedule = :s"};
  dynamoDB.updateItem(params,function(err,data){
    if(err) console.log(err);
  });

  updatestr = {state:{desired:{schedule:schedule}}};
  Robert.updateThingShadow({thingName:"SeaSea",payload:JSON.stringify(updatestr)},function(err,data){
    if(err){
      console.log(err);
      res.status(400);
      res.send("Error.");
    }else{
      res.send("Success.");
    }
  });
});
*/

app.get("*",function(req,res){
  res.send("404 - Request invalid.");
});

app.post("*",function(req,res){
  /*var bodyStr = '';
  console.log("here");
  req.on("data",function(chunk){
    bodyStr += chunk.toString();
  });
  req.on("end",function(){
    iter += 1;
    console.log("post "+iter+".");
    console.log(bodyStr);
    res.send(bodyStr);
  });*/
  res.send("404 - Request invalid.");
});


var signedon=false; //not signed in
http.createServer(app).listen(8080,function(){ // I redirect the port
  console.log("Server running on http://ec2-52-15-137-111.us-east-2.compute.amazonaws.com/");
});

function getDateStr(){/* v */
  curtime = new Date();
  curtime.setHours(curtime.getHours()-4); //account for aws timezone dif
  hours = curtime.getHours();
  minutes = curtime.getMinutes();
  seconds = curtime.getSeconds();
  day = curtime.getDate();
  year = curtime.getFullYear();
  month = curtime.getMonth()+1;
  datestr = year+":"+month+":"+day+":"+hours+":"+minutes+":"+seconds;
  return datestr;
}

function dateDif(date1,date2){
  d1 = new Date();
  d1.setYear(date1.year);
  d1.setMonth(date1.month);
  d1.setDate(date1.day);
  d1.setHours(date1.hour);
  d1.setMinutes(date1.minute);
  d1.setSeconds(date1.second);
  d1.setMilliseconds(0);

  d2 = new Date();
  d2.setYear(date2.year);
  d2.setMonth(date2.month);
  d2.setDate(date2.day);
  d2.setHours(date2.hour);
  d2.setMinutes(date2.minute);
  d2.setSeconds(date2.second);
  d2.setMilliseconds(0);

  return (d2-d1)/1000; //seconds apart
}
      

function parseDate(date){/* v */
  vals = (date+"").split(":");
  if(vals.length != 6) return undefined; //invalid. should be y:mo:d:h:min:s
    nums = [];
    for(i=0;i<vals.length;i++){
      num = parseInt(vals[i]);
       if(num == NaN) return undefined;//invalid number
       else nums.push(parseInt(vals[i])); 
    }
        
    return {year:nums[0],month:nums[1],day:nums[2],
            hour:nums[3],minute:nums[4],second:nums[5]};
}
      
function secondInt(date){/* v */
  monthdays = [31,28,31,30,31,30,31,31,30,31,30,31];
  leapyear = ((date.year - 2016)%4 == 0);
  monthdays[1] += leapyear; //account for leapyear
       
  days = 0;
  for(i=0;i<date.month;i++) days += monthdays[i];
  return (days+date.day)*24*3600+date.hour*3600+date.minute*60+date.second;
}

function inRange(date,date_low,date_high){/* v */
  target = parseDate(date);
  low = parseDate(date_low);
  high = parseDate(date_high);
        
  return (target.year >= low.year && target.year <= high.year &&
          secondInt(target) >= secondInt(low) &&
          secondInt(target) <= secondInt(high));
}

function createTable(){ /* v */
  dynamoDB.createTable({TableName:tableName,
       KeySchema: [{AttributeName:"Timestamp",KeyType:"HASH"}],
       AttributeDefinitions: [{AttributeName:"Timestamp",AttributeType:"S"}],
       ProvisionedThroughput:{ReadCapacityUnits: 1, WriteCapacityUnits:1} },
       function(err,data){console.log(err? err : data);});
}


var PARAMS = {data:[{name:"Timestamp",type:"S",valid: function(x){return true;}},
                    {name:"temp",type:"N",valid: function(x){return x>=40 && x<=100;} },
                    {name:"co2",type:"N",valid: function(x){return x>=0 && x<=100;} },
                    {name:"lights",type:"N",valid: function(x){return x==1 || x==0;} }],
          commands:[{name:"Timestamp",type:"S"},{name:"command",type:"S"}],
            config:[{name:"Timestamp",type:"S"},{name:"lights",type:"N"}, //lights are 0 or 1 to be off or on
                    {name:"temp_target",type:"N"},{name:"temp_lower",type:"N"},{name:"temp_upper",type:"N"},
                    {name: "co2_target",type:"N"},{name: "co2_lower",type:"N"},{name: "co2_upper",type:"N"}],
              fish:[{name:"Timestamp",type:"S"},{name:"id",type:"N"},{name:"name",type:"S"},{name:"url",type:"S"},
                    {name:"temperature_lower",type:"N"},{name:"temperature_upper",type:"N"}]};
var DATA = {};
for(i=0;i<PARAMS.data.length;i++) DATA[PARAMS.data[i].name] = []; 
