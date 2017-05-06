var http         = require("http");          //required to host server
var fs           = require("fs");            //required to send files
var express      = require("express");       //required for requests 
var bodyParser   = require("body-parser");   //required for reading requests
var AWS          = require("aws-sdk");       //required for AWS Services
var cookieParser = require("cookie-parser"); //required for reading cookies
var randtoken    = require("rand-token");    //required for random tokens

//setup express to read/write JSON post/get reqs
var app          = express();
app.use(bodyParser.urlencoded({extended:true}));
app.use(bodyParser.json());
app.use(cookieParser());

var ERROR = {badRequest:400,unauthorized:401,forbidden:403,notFound:404,timeout:408,
             tooManyRequests:429,serverError:500,serviceUnavailable:503,gatewayTimeout:504};
var SUCCESS = {okay:200,created:201,accepted:202,noContent:204};

/* load credentials */
var thingName = "AquaOS", passtableName = "Users", shadowtableName = "Shadows";
var dynamoDB,ShadowAPI;
//var IotData;
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
    //IotData = new AWS.IotData({credentials:creds,endpoint:lines[3],region:lines[2]});
    
    rcreds = new AWS.Credentials(lines[4],lines[5]);
    ShadowAPI = new AWS.IotData({credentials:rcreds,endpoint:lines[6],region:lines[2]});
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
        if(tables.indexOf(passtableName) < 0){ //no users exist.
          dynamoDB.createTable({TableName:passtableName,
            KeySchema: [{AttributeName:"username",KeyType:"HASH"}],
            AttributeDefinitions: [{AttributeName:"username",AttributeType:"S"}],
            ProvisionedThroughput:{ReadCapacityUnits: 1, WriteCapacityUnits:1} },
            function(err,data){
              if(err){
                console.log(error);
                console.log("TLDR: can't create username table");
                process.exit(1);
              }else console.log("User table created. Fresh start");
            });
        }else{
          console.log((tables.length-1) + " users exist"); //assumes one table exists per user, plus users table

          query = {TableName:passtableName,ProjectionExpression:"username,lastAccess"};
          dynamoDB.scan(query,function(err,data){
            if(err) console.log(err);
            else{
              curdate = parseDate(getDateStr());
              for(i=0;i<data.Count;i++){
                username = data.Items[i].username.S;
                lastAccessed = parseDate(data.Items[i].lastAccess.S);
                if(dateDif(lastAccessed,curdate) >= 3600*24*7){ //no access in the past week
                  console.log("Deleting user "+username+"...");
                  dynamoDB.deleteItem({TableName:passtableName,Key:{username:{S:username}}},function(err,data){console.log(err? err : data);});
                }
              }
            }
          });
        }
      }
    });
  }
});

app.get("/test",function(req,res){
  getUser("admin",false);
  getUser("admin",true);
  getUser("admin",false,function(item){
    res.send(item); 
  });
});

function getUser(username,getCredentials, callback){
  if(getCredentials) query = {TableName:passtableName,Key:{"username":{S:username}},ProjectionExpression:"password,theToken,lastAccess"};
  else query = {TableName:passtableName,Key:{"username":{S:username}},ProjectionExpression:"dataname,shadow,lastAccess"};
  dynamoDB.getItem(query,function(err,data){
    if(err){
      console.log("error getting user info for user "+JSON.stringify(username));
      console.log(err);
      if(callback) callback({error:err});
    }else{
      item = data.Item;
      item.username = {S: username};
      if(callback) callback({item:item});
      else console.log(item);
    }
  });
}

app.get("/images/*",function(req,res){ res.sendFile(__dirname+req.url);});
app.get("*.css",function(req,res){ res.sendFile(__dirname+req.url);});

/* handle logins */
var DISABLE_LOGIN = true;
if(process.argv.length>2 && process.argv[2]=="true") DISABLE_LOGIN = false; //command line arg
if(!DISABLE_LOGIN) console.log("Running app with authorization requirements");

app.use(function(req,res,next){
  if(DISABLE_LOGIN ||
     (req.url=="/login" || req.url=="/newUser")) next();
  else if(req.cookies && req.cookies.info){
    if(req.cookies.info && req.cookies.theToken && req.cookies.theToken != ""){
      info = safeParse(req.cookies.info);
      dynamoDB.getItem({TableName:passtableName,Key:{"username":{S:info.username}}},function(err,data){
        if(err){
          console.log(err);
          res.status(ERROR.serverError).send(err);
        }else if(req.cookies && data.Item && info.theToken == data.Item.theToken.S) next();
        else res.redirect("/login");
      });
    }else next();
  }else res.redirect("/login");
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
      res.status(ERROR.unauthorized).send({error:"Invalid username or password."});
    }else{
      token = randtoken.generate(32);
      dynamoDB.updateItem({TableName: passtableName,
          Key:{"username":{S:user}},
          ExpressionAttributeValues:{":s":{S:token}},
          UpdateExpression: "SET theToken = :s"},function(err,data){
        if(err){
          console.log(err);
          res.status(ERROR.serverError).send(err);
        }else{
          console.log("logging in...");
          cookie = {username:user,theToken:token};
          res.cookie("info",cookie);
          res.redirect("/");
          //res.status(SUCCESS.created).send({location:"/myIndex",cookie:cookie,maxAge:3600*1000});
        }
      });
    }
  });
});
app.get("/newUser",function(req,res){
  fs.readFile("newUser.html",function(err,data){
    res.send(data.toString());
  });
});
app.post("/newUser",function(req,res){
  var params = req.body;
  if(!params.password || !params.username || !params.uid){
    res.status(ERROR.badRequest).send({error:"Your request is invalid."});
  }else{
    dynamoDB.getItem({TableName:shadowtableName,Key:{"shadowName":{S:params.uid}}},function(err,data){
      console.log(JSON.stringify(data));
      if(err){
        res.status(ERROR.serverError).send(err);
        console.log(err);
      }else if(!data.Item){
        res.status(ERROR.badRequest).send({error:"This device does not exist"});
      }else{
        dynamoDB.getItem({TableName:passtableName,Key:{"username":{S:params.username}}},function(err,data){
          if(err){
            res.status(ERROR.notFound).send(err);
            console.log(err);
          }else if(data.Item){
            res.status(ERROR.badRequest).send({error:"Username already exists"});
          }else{
            theToken = randtoken.generate(32);
            newuser = {username:{S:params.username},
                       password:{S:params.password},
                       theToken:{S:theToken},
                       lastAccess:{S:getDateStr()}};
            dynamoDB.putItem({TableName:passtableName,Item:newuser},function(err,data){
              if(err){
                res.status(ERROR.serverError).send(err);
                console.log(err);
              }else{
                console.log("logging in...");
                cookie = {username:params.username,theToken:theToken};
                res.cookie("info",JSON.stringify(cookie),{maxAge:3600*1000});
                res.redirect("/");
                //res.status(SUCCESS.created).send({location:"/myIndex",cookie:cookie,maxAge:3600*1000});
              }
            });
          }
        });
      }
    });
  }
});
app.get("/",function(req,res){ //only accessible if user is logged in
  fs.readFile("index.html",function(err,data){
    res.send(data.toString());
  });
});
app.get("/app.min.js",function(req,res){
  fs.readFile("app.min.js",function(err,data){
    res.send(data.toString());
  });
 console.log("requests "+req.url);
});
function safeParse(string){
  try{
    return JSON.parse(string);
  }catch(e){
    return string;
  }
}
app.post("/logout",function(req,res){
  info = safeParse(req.cookies.info);
  dynamoDB.updateItem({TableName: passtableName,
    Key:{"username":{S:info.username}},
    UpdateExpression: "REMOVE theToken"},function(err,data){
    if(err){
      console.log(err);
      res.status(ERROR.serverError).send(err);
    }else{
      res.clearCookie("info");
      res.sendStatus(SUCCESS.noContent);
    }
  });
});

app.post("/reset",function(req,res){
  info = safeParse(req.cookies.info);
  getUser(info.username,false, function(resp){
    console.log("WARNING: restarting table will take about 35 seconds.");
    dynamoDB.deleteTable({TableName:resp.item.dataname.S},function(err,data){
      console.log("deleting table...");
      dynamoDB.waitFor("tableNotExists",{TableName:resp.item.dataname.S},function(err,data){
        if(err) console.log(err);
        else{
          console.log("table deleted! recreating table...");
          createTable(resp.item.dataname.S);
          dynamoDB.waitFor("tableExists",{TableName:resp.item.dataname.S},function(err,data){
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
});

app.get("/shadow",function(req,res){
  info = safeParse(req.cookies.info);
  console.log(info);
  getUser(info.username,false, function(resp){
    console.log(resp);
    console.log("requesting "+resp.item.shadow.S);
    ShadowAPI.getThingShadow({thingName:resp.item.shadow.S},function(err,data){
      if(err){
        console.log(err);
        res.status(ERROR.serverError).send(err);
      }else{
        msg = safeParse(data.payload);
        res.send(msg.state || {});
      }
    });
  });
});

app.post("/shadow",function(req,res){
  var state = req.body.state || "desired";
  delete(req.body.state);
  params = req.body;

  info = safeParse(req.cookies.info);
  getUser(info.username,false,function(resp){
    updatestr = {"state":{}};
    updatestr.state[state] = params;
    console.log(updatestr);
    ShadowAPI.updateThingShadow({thingName:resp.item.shadow.S,payload:JSON.stringify(updatestr)},function(err,data){
      if(err){
        console.log(err);
        res.status(400).send("Error.");
      }else{
        res.send("Success.");
      }
    });
  });
});

app.post("/lambda",function(req,res){
  console.log("Lambda says: "+JSON.stringify(req.body));
  res.send("ack");
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
  info = safeParse(req.cookies.info);
  getUser(info.username,false, function(resp){
    tableName = resp.item.dataname.S;
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
        getData(tableName,"fish",undefined,undefined,undefined,function(data){
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
});

app.get("/fish",function(req,res){
  info = safeParse(req.cookies.info);
  getUser(info.username,false, function(resp){
    tableName = resp.item.dataname.S;
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
});

app.post("/data",function(req,res){
  info = safeParse(req.cookies.info);
  getUser(info.username,false, function(resp){
    console.log(resp.item);
    console.log("Database info requested.");
    type = "data";
    lower = req.body.lower;
    upper = req.body.upper;
    console.log(lower+","+upper);
    getData(resp.item.dataname.S,type,lower,upper,res,undefined);
  });
});

function getData(tableName,type,lower,upper,res,callback){
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

app.get("*",function(req,res){
  console.log(req.url);
  res.status(ERROR.notFound).send("404 - Request invalid.");
});

app.post("*",function(req,res){
  console.log(req.url);
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
  res.status(ERROR.notFound).send("404 - Request invalid.");
});


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

function createTable(databaseName){ /* v */
  dynamoDB.createTable({TableName:databaseName,
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
