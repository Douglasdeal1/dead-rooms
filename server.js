"use strict";

/*
=========================================================
 DEAD ROOMS MOBILE - MULTIPLAYER SERVER
=========================================================

 Estructura:

 dead-rooms/
 ├── index.html
 ├── server.js
 └── package.json

 Este servidor utiliza:

 - Node.js
 - Express
 - Socket.IO
 - Salas privadas
 - Código de 5 caracteres
 - Host + Client
 - Máximo 2 jugadores por sala

 El HOST controla:
 - IA de zombis
 - Oleadas
 - Estado de zombis

 Ambos jugadores envían:
 - Posición
 - Rotación
 - Vida
 - Arma
 - Disparos
=========================================================
*/


/* =====================================================
   MODULES
===================================================== */

const express = require("express");
const http = require("http");
const path = require("path");

const {
    Server
} = require("socket.io");


/* =====================================================
   SERVER
===================================================== */

const app = express();

const httpServer =
    http.createServer(app);

const io =
    new Server(
        httpServer,
        {
            cors:{
                origin:"*",
                methods:[
                    "GET",
                    "POST"
                ]
            },

            pingInterval:10000,
            pingTimeout:20000
        }
    );


/* =====================================================
   CONFIGURATION
===================================================== */

const PORT =
    process.env.PORT ||
    3000;

const MAX_PLAYERS_PER_ROOM = 2;


/* =====================================================
   STATIC WEBSITE
===================================================== */

/*
Entrega index.html y cualquier otro archivo
que coloquemos posteriormente en esta carpeta.
*/

app.use(
    express.static(
        path.join(__dirname)
    )
);


/*
Ruta principal.
*/

app.get(
    "/",
    (req,res)=>{

        res.sendFile(
            path.join(
                __dirname,
                "index.html"
            )
        );
    }
);


/* =====================================================
   HEALTH CHECK
===================================================== */

/*
Útil para comprobar que Render/Replit/etc.
tienen el servidor funcionando.

Ejemplo:

https://tu-juego.com/health
*/

app.get(
    "/health",
    (req,res)=>{

        res.json({
            ok:true,
            game:"Dead Rooms Mobile",
            multiplayer:true,
            rooms:rooms.size,
            players:io.engine.clientsCount,
            timestamp:Date.now()
        });
    }
);


/* =====================================================
   ROOMS
===================================================== */

/*

rooms:

Map {
    "ABCDE" => {

        code:"ABCDE",

        host:"socket-id",

        players:Set(
            socket-id,
            socket-id
        ),

        createdAt:123456789
    }
}

*/

const rooms =
    new Map();


/* =====================================================
   CREATE ROOM CODE
===================================================== */

function createRoomCode(){

    /*
    Quitamos caracteres fáciles de confundir:

    I
    O
    0
    1
    */

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


/* =====================================================
   NORMALIZE ROOM CODE
===================================================== */

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
    .slice(
        0,
        5
    );
}


/* =====================================================
   PLAYER STATE SECURITY
===================================================== */

/*
Nunca reenviamos directamente cualquier cosa
que mande un navegador.

Construimos un objeto pequeño con solamente
los datos que necesita el juego.
*/

function sanitizePlayerState(data){

    data =
        data &&
        typeof data === "object"
        ? data
        : {};

    return {

        x:
            safeNumber(
                data.x,
                0,
                -10000,
                10000
            ),

        y:
            safeNumber(
                data.y,
                0,
                -10000,
                10000
            ),

        rotation:
            safeNumber(
                data.rotation,
                0,
                -100,
                100
            ),

        health:
            safeNumber(
                data.health,
                100,
                0,
                100
            ),

        weaponIndex:
            Math.floor(
                safeNumber(
                    data.weaponIndex,
                    0,
                    0,
                    3
                )
            ),

        dead:
            Boolean(
                data.dead
            )
    };
}


/* =====================================================
   SAFE NUMBER
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


/* =====================================================
   ZOMBIE SNAPSHOT SECURITY
===================================================== */

function sanitizeZombieSnapshot(data){

    if(
        !Array.isArray(data)
    ){
        return [];
    }

    /*
    Protección sencilla para evitar que un
    navegador mande miles de objetos.
    */

    const maximumZombies = 150;

    return data
        .slice(
            0,
            maximumZombies
        )
        .map(
            zombie=>{

                zombie =
                    zombie &&
                    typeof zombie === "object"
                    ? zombie
                    : {};

                let type =
                    String(
                        zombie.type ||
                        "normal"
                    );

                if(
                    type !== "normal" &&
                    type !== "fast" &&
                    type !== "tank"
                ){
                    type="normal";
                }

                return {

                    x:
                        safeNumber(
                            zombie.x,
                            0,
                            -10000,
                            10000
                        ),

                    y:
                        safeNumber(
                            zombie.y,
                            0,
                            -10000,
                            10000
                        ),

                    type:type,

                    radius:
                        safeNumber(
                            zombie.radius,
                            16,
                            5,
                            50
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

                    walkTime:
                        safeNumber(
                            zombie.walkTime,
                            0,
                            -100000,
                            100000
                        )
                };
            }
        );
}


/* =====================================================
   GET SOCKET ROOM
===================================================== */

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
   REMOVE PLAYER FROM ROOM
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


    /*
    HOST SALIÓ
    ------------------------------------

    Si el Host sale, cerramos la partida.

    Más adelante podemos implementar
    Host Migration para que Player 2
    se convierta automáticamente en Host.
    */

    if(
        room.host === socket.id
    ){

        socket
            .to(code)
            .emit(
                "roomClosed"
            );

        /*
        Sacamos a los jugadores restantes
        de la sala de Socket.IO.
        */

        const sockets =
            io.sockets.adapter.rooms.get(
                code
            );

        if(sockets){

            for(
                const socketId
                of sockets
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
                ? "Host disconnected"
                : "Host left"
        );

    }else{

        /*
        CLIENT SALIÓ
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


        /*
        En teoría no debería quedar vacía,
        porque si no está el Host la sala
        se elimina.

        Lo dejamos como protección.
        */

        if(
            room.players.size === 0
        ){
            rooms.delete(code);
        }
    }


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


        /*
        Estado inicial.
        */

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


                /*
                Si ya estaba en una sala,
                primero sale.
                */

                if(
                    socket.data.roomCode
                ){

                    removePlayerFromRoom(
                        socket
                    );
                }


                const code =
                    createRoomCode();


                const room = {

                    code:code,

                    host:
                        socket.id,

                    players:
                        new Set([
                            socket.id
                        ]),

                    createdAt:
                        Date.now()
                };


                rooms.set(
                    code,
                    room
                );


                socket.join(
                    code
                );


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

                    code:code,

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
            }
        );


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


                /*
                Código inválido.
                */

                if(
                    code.length !== 5
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


                /*
                Sala inexistente.
                */

                if(!room){

                    callback({
                        ok:false,
                        message:
                            "Room not found."
                    });

                    return;
                }


                /*
                Sala llena.
                */

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


                /*
                Si estaba previamente en
                otra sala.
                */

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


                socket.join(
                    code
                );


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

                    code:code,

                    playerId:
                        socket.id,

                    isHost:false
                });


                /*
                Avisamos al Host.
                */

                socket
                    .to(code)
                    .emit(
                        "playerJoined",
                        {
                            playerId:
                                socket.id
                        }
                    );


                /*
                Avisamos a todos cuantos
                jugadores hay.
                */

                io
                    .to(code)
                    .emit(
                        "roomPlayers",
                        {
                            count:
                                room.players.size
                        }
                    );
            }
        );


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


                /*
                Solamente el Host puede
                iniciar.
                */

                if(
                    room.host !==
                    socket.id
                ){
                    return;
                }


                /*
                Esperamos los dos jugadores.
                */

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


                console.log(
                    "[MATCH STARTED]",
                    room.code
                );


                /*
                Ambos teléfonos reciben esto.
                */

                io
                    .to(room.code)
                    .emit(
                        "matchStarted",
                        {
                            roomCode:
                                room.code,

                            hostId:
                                room.host
                        }
                    );
            }
        );


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

                if(!room){
                    return;
                }


                const state =
                    sanitizePlayerState(
                        data
                    );


                /*
                Se lo mandamos al otro
                teléfono, no al mismo.
                */

                socket
                    .to(room.code)
                    .emit(
                        "remotePlayerState",
                        {
                            id:
                                socket.id,

                            ...state
                        }
                    );
            }
        );


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

                if(!room){
                    return;
                }


                data =
                    data &&
                    typeof data === "object"
                    ? data
                    : {};


                const shot = {

                    id:
                        socket.id,

                    x:
                        safeNumber(
                            data.x,
                            0,
                            -10000,
                            10000
                        ),

                    y:
                        safeNumber(
                            data.y,
                            0,
                            -10000,
                            10000
                        ),

                    rotation:
                        safeNumber(
                            data.rotation,
                            0,
                            -100,
                            100
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


                socket
                    .to(room.code)
                    .emit(
                        "remoteShoot",
                        shot
                    );
            }
        );


        /* =================================================
           ZOMBIE SNAPSHOT
        ================================================= */

        socket.on(
            "zombieSnapshot",
            data=>{

                const room =
                    getSocketRoom(
                        socket
                    );


                if(!room){
                    return;
                }


                /*
                CRÍTICO:

                Solo aceptamos zombis enviados
                por el Host.
                */

                if(
                    room.host !==
                    socket.id
                ){
                    return;
                }


                const zombies =
                    sanitizeZombieSnapshot(
                        data
                    );


                socket
                    .to(room.code)
                    .emit(
                        "zombieSnapshot",
                        zombies
                    );
            }
        );


        /* =================================================
           WAVE STATE
        ================================================= */

        socket.on(
            "waveState",
            data=>{

                const room =
                    getSocketRoom(
                        socket
                    );


                if(!room){
                    return;
                }


                /*
                Solo el Host puede cambiar
                oleadas/puntuación.
                */

                if(
                    room.host !==
                    socket.id
                ){
                    return;
                }


                data =
                    data &&
                    typeof data === "object"
                    ? data
                    : {};


                const state = {

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
                        )
                };


                socket
                    .to(room.code)
                    .emit(
                        "waveState",
                        state
                    );
            }
        );


        /* =================================================
           LEAVE ROOM
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
            }
        );


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
            }
        );
    }
);


/* =====================================================
   CLEAN OLD EMPTY ROOMS
===================================================== */

/*
Protección adicional.

Cada 10 minutos comprobamos si por algún
motivo quedó una sala fantasma.
*/

setInterval(
    ()=>{

        const now =
            Date.now();

        const MAX_ROOM_AGE =
            1000 *
            60 *
            60 *
            6;


        for(
            const [
                code,
                room
            ]
            of rooms
        ){

            /*
            Sala sin jugadores.
            */

            if(
                room.players.size === 0
            ){

                rooms.delete(code);

                continue;
            }


            /*
            Protección contra salas que
            hayan quedado corruptas durante
            muchas horas.
            */

            if(
                now -
                room.createdAt >
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
    1000 *
    60 *
    10
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
            "   DEAD ROOMS MULTIPLAYER SERVER"
        );

        console.log(
            "======================================"
        );

        console.log(
            "Port:",
            PORT
        );

        console.log(
            "Local:"
        );

        console.log(
            `http://localhost:${PORT}`
        );

        console.log(
            "Multiplayer: ENABLED"
        );

        console.log(
            "Players per room:",
            MAX_PLAYERS_PER_ROOM
        );

        console.log(
            "======================================"
        );

        console.log("");
    }
);