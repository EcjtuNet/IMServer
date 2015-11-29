var app = require('express')();
var server = require('http').Server(app);
var io = require('socket.io')(server);
var redis = require('redis');
var jpush = require('jpush-sdk');
var request = require('request');
var config = require('./config.js');

var jpush_client = jpush.buildClient(config.jpush.app, config.jpush.secret);

server.listen(config.port);
redis_client = redis.createClient(config.redis.port, config.redis.server);

redis_client.on("error", function (error) {
  console.log(error);
})

app.get('/', function (req, res) {
  res.sendfile(__dirname + '/index.html');
});

app.get('/unread', function (req, res) {
  redis_client.lrange('message_history:' + req.params.uid, function (err, list) {
    var result = {};
    if (err || !list) {
      return res.send(JSON.stringify({}));
    }
    list.forEach(function (msg) {
      if (! msg.from in result) {
        result[msg.from] = {
          count: 1,
          recent: msg.content.text
        }
      }
      else {
        result[msg.from]['count'] = result[msg.from]['count'] + 1;
        result[msg.from]['recent'] = msg.content.text;
      }
    });
    res.send(JSON.stringify(result));
  });
});

var clients_online = {};

require('socketio-auth')(io, {
  authenticate: function (socket, data, callback) { 
    var sid = data.sid;
    var token = data.token;

    console.log(Date() + ':AUTH:' + socket.handshake.address + ':' + sid + ':' + token);

    if (clients_online[sid]) {
      return callback(new Error("You've logged"))
    }

    if (sid < 10000) {
      return callback(null, token == config.admin.key)
    } else {
      request.post({
        url: config.usercenter.api + 'checktoken', 
        form: {
          username: sid,
          token: token
        },
      }, 
      function (err, res, body) {
        result = JSON.parse(body).result;
        if (err || !result) return callback(new Error("Token error"));
        return callback(null, true);
      });
    }
  },
  postAuthenticate: function (socket, data) {
    var sid = data.sid;
    var chatting_with = data.to;
    clients_online[sid] = {
      socket: socket,
      chatting_with: chatting_with
    };
    socket.client.sid = data.sid;
    socket.client.is_admin = data.sid < 10000;
    redis_client.sadd('allusers', data.sid);
  },
  timeout: 1000
});

io.on('connection', function (socket) {
  console.log(Date() + ':CONN:' + socket.handshake.address)
  send_stored_message(socket);
  socket.on('chat', function (data) {
    data.server_time = Number(new Date());
    data.from = socket.client.sid;
    console.log(Date() + ':CHAT:' + socket.handshake.address + ':' + data.from + ':' + data.to + ':' + data.content.text);
    if (data.type == 'text') {
      if (clients_online[data.to]
        && [data.from, 'all'].indexOf(clients_online[data.to]['chatting_with']) > -1 ) {
        send_message(clients_online[data.to][socket], data);
      }
      else {
        store_message(data.to, data.from, data);
        push_message(data.to, data.from, data);
      }
    };
  });
  socket.on('broadcast', function (data) {
    if (socket.client.is_admin) {

    };
  });
  socket.on('history', function () {
    redis_client.lrange('message_history:' + socket.client.sid, function (err, list) {
      list.forEach(function (msg) {
        send_message(socket, msg);
      });
    });
  });
  socket.on('disconnect', function () {
    delete clients_online[socket.client.sid];
    console.log(Date() + ':DISC:' + socket.handshake.address + ':' + socket.client.sid);
  });
});

function send_message(socket, msg) {
  socket.emit('chat', msg);
  redis_client.rpush('message_history:' + msg.from, JSON.stringify(msg));
  redis_client.rpush('message_history:' + msg.to, JSON.stringify(msg));
}

function store_message(to, from, data) {
  redis_client.rpush('message_stored:' + to + ':' + from, JSON.stringify(data));
}

function push_message(to, from, data) {
  jpush_client.push().setPlatform(jpush.ALL)
    .setAudience(jpush.alias(to))
    .setNotification(jpush.android(data.content.text, 'New message!', 2, data))
    .send(function (err, res) {
      if (err) {
        console.log(Date() + ':PUSH:ERRO:' + err.message);
      } else {
        console.log(Date() + ':PUSH:SUCC:' + res.sendno + ':' + res.msg_id);
      }
    });
}

function send_stored_message(socket) {
  var chatting_with = clients_online[socket.client.sid]['chatting_with']
  if (chatting_with == 'all') {
    redis_client.keys('message_stored:' + socket.client.sid + ':*', function (err, keys) {
      keys.forEach(function (key) {
        redis_client.lrange(key, 0, -1, function (err, list) {
          list.forEach(function (msg) {
            send_message(socket, JSON.parse(msg));
          });
        });
      });
    });
  }
  else {
    redis_client.lrange('message_stored:' + socket.client.sid + ':' + chatting_with, 0, -1, function (err, list) {
      list.forEach(function (msg) {
        send_message(socket, JSON.parse(msg));
      });
    });
  }
}