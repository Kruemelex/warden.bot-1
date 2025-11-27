if (process.env.SOCKET_TOKEN && process.env.MODE == "PROD") { 
    const { botIdent } = require('../functions')
    const { Manager } = require('socket.io-client')
    const jwt = require('jsonwebtoken')
    let options = { timeZone: 'America/New_York',year: 'numeric',month: 'numeric',day: 'numeric',hour: 'numeric',minute: 'numeric',second: 'numeric',},myTime = new Intl.DateTimeFormat([], options);
    
    try {
        console.log("[SOCKET CLIENT]".blue,"STATUS:"," OPERATIONAL ".green)
        const payload = {
            user: botIdent().activeBot.botName,
            userID: process.env.HOSTNAME
        }
        const secretKey = process.env.SOCKET_TOKEN
        const token = jwt.sign(payload, secretKey)
        const manager = new Manager('https://elitepilotslounge.com/antixenoinitiative-socketserver/', {
            secure: true,
            query: { 'botClient': botIdent().activeBot.botName, 'type': 'client', token: token },
            path: '/antixenoinitiative-socketserver/',
            upgrade: true,
            rememberUpgrade: true,
            withCredentials: true,
            auth: {
                token: token
            },
            reconnection: true,               // allow reconnects
            reconnectionAttempts: Infinity,   // keep retrying
            reconnectionDelay: 1000,          // 1s initial delay
            reconnectionDelayMax: 5000,       // 5s max delay
            timeout: 20000                    // 20s connection timeout
        })
        
        const socket = manager.socket("/")
        manager.open((err) => {
            if (err) {
                console.log('connect error. error code generated from socketMain.js')
            } else {
                console.log("connection succ")
            }
        });
        const sockF = {
            test: function(data) {
                console.log("test".yellow,`${data}`.yellow)
                return data
            },
        }
        module.exports = { sockF, socket }
        
        let socketRooms = null;
    
        socket.on("connect", () => {
            console.log("[SOCKET CLIENT]".blue,"Socket ID: ",`${socket.id}`.green)
            function socketReconnect(data) {
                return new Promise(async (resolve,reject) => {
                    try { socket.emit('joinRoom',data, async (response) => { 
                        resolve(response);
                        socketRooms = response 
                    }); }
                    catch(error) { console.log(error); reject(error) }
                })
            }  
            socketReconnect(botIdent().activeBot.socketRoom.id)
        })
        socket.on("disconnect", (reason) => {
            console.log("[SOCKET CLIENT]".blue,"Disconnect Reason: ".bgRed,reason)
            socketRooms = false
            // else the socket will automatically try to reconnect
        });
        socket.on("error", (e) => {
            console.log('socket error',e)
            socketRooms = false
        })
        socket.io.on("reconnect_attempt", (e) => {
             console.log("[SOCKET CLIENT]".blue,"Reconnect Attempt # ".red,e) 
        })
        manager.on("connect_error", (err) => {
            console.log("[SOCKET CLIENT]".blue,"Connect Error:", err.message)
        })

        manager.on("connect_timeout", (timeout) => {
            console.log("[SOCKET CLIENT]".blue,"Connect Timeout:", timeout)
        })
        
    }
    catch(error) {
        console.log(error)
    }
}