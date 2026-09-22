"use strict";

/* =========================================================
   DEAD ROOMS MOBILE
   MULTIPLAYER SERVER V2

   - Node.js
   - Express
   - Socket.IO
   - 2 jugadores por sala
   - Host autoritativo para zombis, daño y mundo
========================================================= */

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

/* =====================================================
   SERVER
===================================================== */

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {

    cors:{
        origin:"*",
        methods:["GET","POST"]
    },

    pingInterval:10000,
    pingTimeout:20000
});

const PORT = process.env.PORT || 3000;

const MAX_PLAYERS_PER_ROOM = 2;

/*
El mundo es SIEMPRE 1280x720.

Esto coincide con el nuevo index.html.
*/

const WORLD_W = 1280;
const WORLD_H = 720;

/* =====================================================
   WEBSITE
===================================================== */

app.use(
    express.static(
        path.join(__dirname)
    )
);

app.get("/", (req,res)=>{

    res.sendFile(
        path.join(
            __dirname,
            "index.html"
        )
    );
});

/* =====================================================
   ROOMS
===================================================== */

const rooms = new Map();

/* =====================================================
   HEALTH
===================================================== */

app.get("/health",(req,res)=>{

    res.json({

        ok:true,

        game:"Dead Rooms Mobile",

        multiplayer:true,

        version:2,

        rooms:rooms.size,

        players:
            io.engine.clientsCount,

        world:{
            width:WORLD_W,
            height:WORLD_H
        },

        timestamp:
            Date.now()
    });
});

/* =====================================================
   HELPERS
===================================================== */

function safeNumber(
    value,
    fallback,
    min,
    max
){

    const number =
        Number(value);

    if(
        !Number.isFinite(number)
    ){
        return fallback;
    }

    return Math.max(
        min,
        Math.min(
            max,
            number
        )
    );
}


function normalizeRoomCode(value){

    return String(
        value || ""
    )
    .trim()
    .toUpperCase()
    .replace(
        /[^A-Z0-9]/g,
        ""
    )
    .slice(0,5);
}


function createRoomCode(){

    const characters =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do{

        code="";

        for(
            let i=0;
            i<5;
            i++
        ){

            code +=
                characters[
                    Math.floor(
                        Math.random() *
                        characters.length
                    )
                ];
        }

    }while(
        rooms.has(code)
    );

    return code;
}


function getSocketRoom(socket){

    const code =
        socket.data.roomCode;

    if(!code){
        return null;
    }

    return (
        rooms.get(code) ||
        null
    );
}

/* =====================================================
   PLAYER STATE
===================================================== */

function createInitialPlayerState(
    isHost
){

    return {

        x:
            isHost
            ?590
            :690,

        y:360,

        rotation:0,

        health:100,

        weaponIndex:0,

        dead:false
    };
}


function sanitizePlayerState(data){

    data =
        data &&
        typeof data==="object"
        ?data
        :{};

    return {

        /*
        Nunca permitimos coordenadas
        fuera del mundo lógico.
        */

        x:
            safeNumber(
                data.x,
                640,
                45,
                WORLD_W-45
            ),

        y:
            safeNumber(
                data.y,
                360,
                45,
                WORLD_H-45
            ),

        rotation:
            safeNumber(
                data.rotation,
                0,
                -Math.PI*4,
                Math.PI*4
            ),

        weaponIndex:
            Math.floor(
                safeNumber(
                    data.weaponIndex,
                    0,
                    0,
                    3
                )
            )
    };
}

/* =====================================================
   ZOMBIES
===================================================== */

function sanitizeZombies(data){

    if(
        !Array.isArray(data)
    ){
        return [];
    }

    return data
        .slice(0,150)
        .map(zombie=>{

            zombie =
                zombie &&
                typeof zombie==="object"
                ?zombie
                :{};

            let type =
                String(
                    zombie.type ||
                    "normal"
                );

            if(
                type!=="normal" &&
                type!=="fast" &&
                type!=="tank"
            ){
                type="normal";
            }

            return {

                x:
                    safeNumber(
                        zombie.x,
                        640,
                        0,
                        WORLD_W
                    ),

                y:
                    safeNumber(
                        zombie.y,
                        360,
                        0,
                        WORLD_H
                    ),

                type,

                radius:
                    safeNumber(
                        zombie.radius,
                        16,
                        5,
                        40
                    ),

                health:
                    safeNumber(
                        zombie.health,
                        100,
                        0,
                        10000
                    ),

                maxHealth:
                    safeNumber(
                        zombie.maxHealth,
                        100,
                        1,
                        10000
                    ),

                dead:
                    Boolean(
                        zombie.dead
                    )
            };
        });
}

/* =====================================================
   ROOM PLAYERS
===================================================== */

function getHostSocket(room){

    return io.sockets.sockets.get(
        room.host
    );
}


function getClientId(room){

    for(
        const playerId
        of room.players
    ){

        if(
            playerId !==
            room.host
        ){

            return playerId;
        }
    }

    return null;
}

/* =====================================================
   REMOVE PLAYER
===================================================== */

function removePlayerFromRoom(
    socket,
    disconnected=false
){

    const code =
        socket.data.roomCode;

    if(!code){
        return;
    }

    const room =
        rooms.get(code);

    if(!room){

        socket.data.roomCode=null;
        socket.data.isHost=false;

        return;
    }

    room.players.delete(
        socket.id
    );

    room.playerStates.delete(
        socket.id
    );

    /*
    HOST SALE:
    cerramos la sala.
    */

    if(
        room.host === socket.id
    ){

        socket
            .to(code)
            .emit(
                "roomClosed"
            );

        const sockets =
            io.sockets.adapter.rooms.get(
                code
            );

        if(sockets){

            for(
                const socketId
                of [...sockets]
            ){

                const client =
                    io.sockets.sockets.get(
                        socketId
                    );

                if(client){

                    client.data.roomCode=null;
                    client.data.isHost=false;

                    client.leave(code);
                }
            }
        }

        rooms.delete(code);

        console.log(
            "[ROOM CLOSED]",
            code,
            disconnected
                ?"Host disconnected"
                :"Host left"
        );

        return;
    }

    /*
    CLIENT SALE.
    */

    socket
        .to(code)
        .emit(
            "playerLeft",
            {
                playerId:
                    socket.id
            }
        );

    io
        .to(code)
        .emit(
            "roomPlayers",
            {
                count:
                    room.players.size
            }
        );

    socket.leave(code);

    socket.data.roomCode=null;
    socket.data.isHost=false;
}

/* =====================================================
   SOCKET.IO
===================================================== */

io.on(
"connection",
socket=>{

    console.log(
        "[CONNECTED]",
        socket.id
    );

    socket.data.roomCode=null;
    socket.data.isHost=false;

    /* =================================================
       CREATE ROOM
    ================================================= */

    socket.on(
    "createRoom",
    callback=>{

        if(
            typeof callback !==
            "function"
        ){
            return;
        }

        if(
            socket.data.roomCode
        ){

            removePlayerFromRoom(
                socket
            );
        }

        const code =
            createRoomCode();

        const hostState =
            createInitialPlayerState(
                true
            );

        const room = {

            code,

            host:
                socket.id,

            players:
                new Set([
                    socket.id
                ]),

            playerStates:
                new Map(),

            started:false,

            worldState:{
                wave:0,
                score:0,
                enemiesToSpawn:0,
                zombies:[]
            },

            createdAt:
                Date.now()
        };

        room.playerStates.set(
            socket.id,
            hostState
        );

        rooms.set(
            code,
            room
        );

        socket.join(code);

        socket.data.roomCode=
            code;

        socket.data.isHost=
            true;

        console.log(
            "[ROOM CREATED]",
            code,
            "HOST:",
            socket.id
        );

        callback({

            ok:true,

            code,

            playerId:
                socket.id,

            isHost:true
        });

        io
            .to(code)
            .emit(
                "roomPlayers",
                {
                    count:1
                }
            );
    });

    /* =================================================
       JOIN ROOM
    ================================================= */

    socket.on(
    "joinRoom",
    (
        rawCode,
        callback
    )=>{

        if(
            typeof callback !==
            "function"
        ){
            return;
        }

        const code =
            normalizeRoomCode(
                rawCode
            );

        if(
            code.length!==5
        ){

            callback({
                ok:false,
                message:
                    "Invalid room code."
            });

            return;
        }

        const room =
            rooms.get(code);

        if(!room){

            callback({
                ok:false,
                message:
                    "Room not found."
            });

            return;
        }

        if(
            room.started
        ){

            callback({
                ok:false,
                message:
                    "Match already started."
            });

            return;
        }

        if(
            room.players.size >=
            MAX_PLAYERS_PER_ROOM
        ){

            callback({
                ok:false,
                message:
                    "Room is full."
            });

            return;
        }

        if(
            socket.data.roomCode
        ){

            removePlayerFromRoom(
                socket
            );
        }

        room.players.add(
            socket.id
        );

        room.playerStates.set(
            socket.id,
            createInitialPlayerState(
                false
            )
        );

        socket.join(code);

        socket.data.roomCode=
            code;

        socket.data.isHost=
            false;

        console.log(
            "[PLAYER JOINED]",
            socket.id,
            "ROOM:",
            code
        );

        callback({

            ok:true,

            code,

            playerId:
                socket.id,

            isHost:false
        });

        socket
            .to(code)
            .emit(
                "playerJoined",
                {
                    playerId:
                        socket.id
                }
            );

        io
            .to(code)
            .emit(
                "roomPlayers",
                {
                    count:
                        room.players.size
                }
            );
    });

    /* =================================================
       START MATCH
    ================================================= */

    socket.on(
    "startMatch",
    ()=>{

        const room =
            getSocketRoom(
                socket
            );

        if(!room){
            return;
        }

        if(
            room.host !==
            socket.id
        ){
            return;
        }

        if(
            room.players.size <
            MAX_PLAYERS_PER_ROOM
        ){

            socket.emit(
                "startError",
                {
                    message:
                        "Waiting for Player 2."
                }
            );

            return;
        }

        room.started=true;

        /*
        Reiniciamos vida de ambos.
        */

        for(
            const playerId
            of room.players
        ){

            const isPlayerHost =
                playerId ===
                room.host;

            room.playerStates.set(
                playerId,
                createInitialPlayerState(
                    isPlayerHost
                )
            );
        }

        room.worldState={
            wave:0,
            score:0,
            enemiesToSpawn:0,
            zombies:[]
        };

        console.log(
            "[MATCH STARTED]",
            room.code
        );

        io
            .to(room.code)
            .emit(
                "matchStarted",
                {
                    roomCode:
                        room.code,

                    hostId:
                        room.host,

                    worldWidth:
                        WORLD_W,

                    worldHeight:
                        WORLD_H
                }
            );
    });

    /* =================================================
       PLAYER STATE
    ================================================= */

    socket.on(
    "playerState",
    data=>{

        const room =
            getSocketRoom(
                socket
            );

        if(
            !room ||
            !room.started
        ){
            return;
        }

        const movement =
            sanitizePlayerState(
                data
            );

        let current =
            room.playerStates.get(
                socket.id
            );

        if(!current){

            current =
                createInitialPlayerState(
                    socket.id ===
                    room.host
                );
        }

        /*
        IMPORTANTE:

        Aceptamos posición/rotación/arma.

        NO aceptamos health/dead enviados
        por el navegador como autoridad.

        De esa forma Player 2 no puede
        volver accidentalmente a 100 HP
        después de que el Host lo dañó.
        */

        current.x=
            movement.x;

        current.y=
            movement.y;

        current.rotation=
            movement.rotation;

        current.weaponIndex=
            movement.weaponIndex;

        room.playerStates.set(
            socket.id,
            current
        );

        socket
            .to(room.code)
            .emit(
                "remotePlayerState",
                {
                    id:
                        socket.id,

                    x:
                        current.x,

                    y:
                        current.y,

                    rotation:
                        current.rotation,

                    health:
                        current.health,

                    weaponIndex:
                        current.weaponIndex,

                    dead:
                        current.dead
                }
            );
    });

    /* =================================================
       WEAPON CHANGE
    ================================================= */

    socket.on(
    "weaponChanged",
    data=>{

        const room =
            getSocketRoom(
                socket
            );

        if(!room){
            return;
        }

        const index =
            Math.floor(
                safeNumber(
                    data?.weaponIndex,
                    0,
                    0,
                    3
                )
            );

        const state =
            room.playerStates.get(
                socket.id
            );

        if(state){

            state.weaponIndex=
                index;

            room.playerStates.set(
                socket.id,
                state
            );
        }

        socket
            .to(room.code)
            .emit(
                "remoteWeaponChanged",
                {
                    id:
                        socket.id,

                    weaponIndex:
                        index
                }
            );
    });

    /* =================================================
       SHOOT
    ================================================= */

    socket.on(
    "shoot",
    data=>{

        const room =
            getSocketRoom(
                socket
            );

        if(
            !room ||
            !room.started
        ){
            return;
        }

        const state =
            room.playerStates.get(
                socket.id
            );

        if(!state || state.dead){
            return;
        }

        data =
            data &&
            typeof data==="object"
            ?data
            :{};

        /*
        Usamos la posición conocida del
        jugador como origen.

        No confiamos totalmente en x/y
        enviados específicamente en shoot.
        */

        const shot={

            id:
                socket.id,

            x:
                state.x,

            y:
                state.y,

            rotation:
                safeNumber(
                    data.rotation,
                    state.rotation,
                    -Math.PI*4,
                    Math.PI*4
                ),

            weaponIndex:
                Math.floor(
                    safeNumber(
                        data.weaponIndex,
                        state.weaponIndex,
                        0,
                        3
                    )
                )
        };

        state.rotation=
            shot.rotation;

        state.weaponIndex=
            shot.weaponIndex;

        socket
            .to(room.code)
            .emit(
                "remoteShoot",
                shot
            );
    });

    /* =================================================
       AUTHORITATIVE HEALTH
       HOST -> SERVER -> PLAYERS
    ================================================= */

    socket.on(
    "authoritativeHealth",
    data=>{

        const room =
            getSocketRoom(
                socket
            );

        if(
            !room ||
            !room.started
        ){
            return;
        }

        /*
        SOLAMENTE EL HOST puede
        modificar vida.
        */

        if(
            room.host !==
            socket.id
        ){
            return;
        }

        data =
            data &&
            typeof data==="object"
            ?data
            :{};

        const target =
            data.target === "client"
            ?"client"
            :"host";

        let targetId;

        if(
            target==="host"
        ){

            targetId=
                room.host;

        }else{

            targetId=
                getClientId(
                    room
                );
        }

        if(!targetId){
            return;
        }

        const state =
            room.playerStates.get(
                targetId
            );

        if(!state){
            return;
        }

        const health =
            safeNumber(
                data.health,
                state.health,
                0,
                100
            );

        state.health=
            health;

        state.dead=
            health<=0 ||
            Boolean(
                data.dead
            );

        room.playerStates.set(
            targetId,
            state
        );

        /*
        Todos reciben el resultado,
        incluido el Host.
        */

        io
            .to(room.code)
            .emit(
                "authoritativeHealth",
                {
                    target,
                    health:
                        state.health,

                    dead:
                        state.dead
                }
            );
    });

    /* =================================================
       WORLD STATE
       HOST -> SERVER -> CLIENT
    ================================================= */

    socket.on(
    "worldState",
    data=>{

        const room =
            getSocketRoom(
                socket
            );

        if(
            !room ||
            !room.started
        ){
            return;
        }

        /*
        Solamente Host.
        */

        if(
            room.host !==
            socket.id
        ){
            return;
        }

        data =
            data &&
            typeof data==="object"
            ?data
            :{};

        const worldState={

            wave:
                Math.floor(
                    safeNumber(
                        data.wave,
                        0,
                        0,
                        10000
                    )
                ),

            score:
                Math.floor(
                    safeNumber(
                        data.score,
                        0,
                        0,
                        999999999
                    )
                ),

            enemiesToSpawn:
                Math.floor(
                    safeNumber(
                        data.enemiesToSpawn,
                        0,
                        0,
                        10000
                    )
                ),

            zombies:
                sanitizeZombies(
                    data.zombies
                )
        };

        room.worldState=
            worldState;

        /*
        Solo necesitamos enviarlo al Client.
        El Host ya tiene estos datos.
        */

        socket
            .to(room.code)
            .emit(
                "worldState",
                worldState
            );
    });

    /* =================================================
       LEAVE
    ================================================= */

    socket.on(
    "leaveRoom",
    callback=>{

        removePlayerFromRoom(
            socket
        );

        if(
            typeof callback ===
            "function"
        ){

            callback({
                ok:true
            });
        }
    });

    /* =================================================
       DISCONNECT
    ================================================= */

    socket.on(
    "disconnect",
    reason=>{

        console.log(
            "[DISCONNECTED]",
            socket.id,
            reason
        );

        removePlayerFromRoom(
            socket,
            true
        );
    });
});

/* =====================================================
   CLEAN OLD ROOMS
===================================================== */

setInterval(
()=>{

    const now=
        Date.now();

    const MAX_ROOM_AGE=
        1000*
        60*
        60*
        6;

    for(
        const [
            code,
            room
        ]
        of rooms
    ){

        if(
            room.players.size===0
        ){

            rooms.delete(code);

            continue;
        }

        if(
            now-
            room.createdAt
            >
            MAX_ROOM_AGE
        ){

            io
                .to(code)
                .emit(
                    "roomClosed"
                );

            rooms.delete(code);

            console.log(
                "[OLD ROOM REMOVED]",
                code
            );
        }
    }

},
1000*60*10
);

/* =====================================================
   SERVER START
===================================================== */

httpServer.listen(
PORT,
"0.0.0.0",
()=>{

    console.log("");
    console.log(
        "======================================"
    );

    console.log(
        " DEAD ROOMS MULTIPLAYER SERVER V2"
    );

    console.log(
        "======================================"
    );

    console.log(
        "Port:",
        PORT
    );

    console.log(
        "World:",
        WORLD_W+"x"+WORLD_H
    );

    console.log(
        "Multiplayer: ENABLED"
    );

    console.log(
        "Players per room:",
        MAX_PLAYERS_PER_ROOM
    );

    console.log(
        `Local: http://localhost:${PORT}`
    );

    console.log(
        "======================================"
    );

    console.log("");
});
