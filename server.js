var http = require("http");
var fs = require("fs");
var express = require("express");
var bodyParser = require("body-parser");
var AWS = require("aws-sdk");
var app = express();

app.use(bodyParser.urlencoded({extended:true}));
app.use(bodyParser.json());

/* load credentials */
var thingName = "AquaOS";
var tableName = "TempWatch";
var creds = new AWS.Credentials();
var dynamoDB;
var IotData;
fs.readFile("credentials","utf8",function(err,data){
  if(err) console.log(err);
  else{
    lines=data.split("\n");
    creds.accessKeyId = lines[0];
    creds.secretAccessKey = lines[1];
    var myConfig = new AWS.Config();
    myConfig.update({region:lines[2],credentials:creds});
    dynamoDB = new AWS.DynamoDB(myConfig);
    IotData = new AWS.IotData({credentials:creds,endpoint:lines[3],region:lines[2]});
    delete(lines);
    delete(myConfig);
  }
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
}

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
  res.header("Access-Control-Allow-Origin","*");
  res.header("Access-Control-Allow-Headers","Origin,X-Requested-With,Content-Type,Accept");
  console.log("SHADOW");
  console.log(req.body);
  var state = "desired";
  var co2 = req.body.co2,
     temp = req.body.temperature,
     dimensions = req.body.dimensions;

  updatestr = {"state":{}};
  params={};
  params.co2 = co2;
  params.temp = temp;
  params.dimensions = dimensions;

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

app.post("/elem",function(req,res){
  var newdata = req.body.newdata;
  dynamoDB.waitFor("tableExists",{TableName:tableName},function(err,data){
    item = {};
    for(i=0;i<=PARAMS.data.length;i++){
      if(i==PARAMS.data.length) param = {name:"type",type:"S"};
      else param = PARAMS.data[i];
      name = param.name;
      type = param.type;
      val = {};
      val[type] = ""+newdata[name];
      item[name] = val;
    }
    dynamoDB.putItem({Item:item,TableName:tableName,ReturnConsumedCapacity:"TOTAL"},function(err,data){
      if(err) console.log(err);
      else console.log("posted!");
    });
  });
}

app.post("/data",function(req,res){
  console.log("Database info requested.");
  type = "data";
  lower = req.body.lower;
  upper = req.body.upper;
 
  console.log(lower+","+upper);
 
  //first make sure table exists
  dynamoDB.waitFor("tableExists",{TableName:tableName},function(err,data){
    //get values
    dynamoDB.scan({TableName:tableName}, function(err, data) {
      if (err) console.log(err, err.stack); // an error occurred
      else{
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
        res.send(values); //gets rid of NaNs
      }
    });
  });
});

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
  res.send("NOOOOO BAD POST");
});

http.createServer(app).listen(8080,function(){
	console.log("Server running on http://ec2-52-15-137-111.us-east-2.compute.amazonaws.com/");
});

function getDateStr(){/* v */
  curtime = new Date();
  hours = curtime.getHours();
  minutes = curtime.getMinutes();
  seconds = curtime.getSeconds();
  day = curtime.getDate();
  year = curtime.getFullYear();
  month = curtime.getMonth()+1;
  datestr = year+":"+month+":"+day+":"+hours+":"+minutes+":"+seconds;
  return datestr;
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
              fish:[{name:"Timestamp",type:"S"},{name:"species",type:"S"}]};
      var DATA = {};
      for(i=0;i<PARAMS.data.length;i++) DATA[PARAMS.data[i].name] = []; 
