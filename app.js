"use strict";

const express = require("express");
const app = express();

const cmd = require("node-cmd");
const crypto = require("crypto"); 
const bodyParser = require("body-parser");

const fs = require("fs");
const dotenv = require("dotenv").config();
const debug = process.env.DEBUG || "true";

let options;
if (!debug) {
    options = {
        key: fs.readFileSync(process.env.KEY_PATH),
        cert: fs.readFileSync(process.env.CERT_PATH)
    };
}

const https = require("https").createServer(options, app);

// default -- pingInterval: 1000 * 25, pingTimeout: 1000 * 60
// low latency -- pingInterval: 1000 * 5, pingTimeout: 1000 * 10
let io, http;
const ping_interval = 1000 * 5;
const ping_timeout = 1000 * 10;
const port_http = process.env.PORT_HTTP || 8080;
const port_https = process.env.PORT_HTTPS || 443;
const port_ws = process.env.PORT_WS || 4321;

const WebSocket = require("ws");
const ws = new WebSocket.Server({ port: port_ws, pingInterval: ping_interval, pingTimeout: ping_timeout }, function() {
    console.log("\nNode.js listening on websocket port " + port_ws);
});

if (!debug) {
    http = require("http");

    http.createServer(function(req, res) {
        res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
        res.end();
    }).listen(port_http);

    io = require("socket.io")(https, { 
        pingInterval: ping_interval,
        pingTimeout: ping_timeout
    });
} else {
    http = require("http").Server(app);

    io = require("socket.io")(http, { 
        pingInterval: ping_interval,
        pingTimeout: ping_timeout
    });
}

// ~ ~ ~ ~
    
app.use(express.static("public")); 

// https://opensourcelibs.com/lib/glitchub
app.use(bodyParser.json());

const onWebhook = (req, res) => {
  let hmac = crypto.createHmac("sha1", process.env.SECRET);
  let sig  = `sha1=${hmac.update(JSON.stringify(req.body)).digest("hex")}`;

  if (req.headers["x-github-event"] === "push" && sig === req.headers["x-hub-signature"]) {
    cmd.run("chmod +x ./redeploy.sh"); 
    cmd.run("./redeploy.sh");
    cmd.run("refresh");
  }

  return res.sendStatus(200);
}

app.post("/redeploy", onWebhook);

app.get("/", function(req, res) {
    res.sendFile(__dirname + "/public/index.html");
});

// ~ ~ ~ ~

if (!debug) {
    https.listen(port_https, function() {
        console.log("\nNode.js listening on https port " + port_https);
    });
} else {
    http.listen(port_http, function() {
        console.log("\nNode.js listening on http port " + port_http);
    });
}

// ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~

io.on("connection", function(socket) {
    console.log("A socket.io user connected.");
    //~
    socket.on("disconnect", function(event) {
        console.log("A socket.io user disconnected.");
    });
    //~
    socket.on("example", function(data) { 
        console.log(data);
        //let newData = JSON.parse(data);
        //io.emit("newMessage", test);
    });
});

ws.on("connection", function(socket) {
    console.log("A ws user connected.");
    //~
    socket.onclose = function(event) {
        console.log("A ws user disconnected.");
    };
    //~
    socket.onmessage = function(event) {
        //socket.send(JSON.stringify(test));
    };
});
