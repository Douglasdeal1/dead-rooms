"use strict";

/*
=========================================================
 DEAD ROOMS MOBILE - MULTIPLAYER SERVER V3

 - 2 jugadores por sala
 - Host autoritativo para zombis y daño
 - Ambos jugadores pueden disparar
 - Sincronización de armas
 - Sincronización de vida/muerte
 - La partida continúa si uno muere
 - Game Over se controla cuando ambos mueren
 - Mundo fijo 1280 x 720
=========================================================
*/

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});


/* =====================================================
   CONFIG
===================================================== */

const PORT = process.env.PORT || 3000;

const WORLD_W = 1280;
const WORLD_H = 720;

const MAX_PLAYERS = 2;

const ROOM_CODE_LENGTH = 5;

const ROOM_MAX_AGE =
    1000 * 60 * 60 * 6;


/* =====================================================
   STATIC FILES
===================================================== */

app.use(
    express.static(__dirname)
);


/* =====================================================
   HEALTH CHECK
===================================================== */

app.get(
    "/health",
    (req, res) => {

        res.json({
            ok: true,
            game: "Dead Rooms Mobile",
            version: 3,
            multiplayer: true,
            world: {
                width: WORLD_W,
                height: WORLD_H
            },
            rooms: rooms.size,
            sockets: io.engine.clientsCount,
            timestamp: new Date().toISOString()
        });
    }
);


/* =====================================================
   ROOMS
===================================================== */

const rooms = new Map();


/* =====================================================
   HELPERS
===================================================== */

function clamp(
    value,
    min,
    max
) {

    return Math.max(
        min,
        Math.min(
            max,
            value
        )
    );
}


function numberOr(
    value,
    fallback
) {

    const n =
        Number(value);

    return Number.isFinite(n)
        ? n
        : fallback;
}


function generateRoomCode() {

    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do {

        code = "";

        for (
            let i = 0;
            i < ROOM_CODE_LENGTH;
            i++
        ) {

            code +=
                chars[
                    Math.floor(
                        Math.random() *
                        chars.length
                    )
                ];
        }

    } while (
        rooms.has(code)
    );

    return code;
}


function getRoomBySocket(
    socket
) {

    const code =
        socket.data.roomCode;

    if (!code) {
        return null;
    }

    return rooms.get(code) || null;
}


function isRoomHost(
    socket,
    room
) {

    return Boolean(
        room &&
        room.host === socket.id
    );
}


/* =====================================================
   PLAYER STATE
===================================================== */

function createInitialPlayerState(
    isHost
) {

    return {

        x:
            isHost
                ? 590
                : 690,

        y: 360,

        rotation: 0,

        health: 100,

        dead: false,

        weaponIndex: 0
    };
}


/*
El cliente solamente puede controlar:

- posición
- rotación
- arma

NO puede decidir su propia vida o muerte.
Eso queda en manos del Host.
*/

function sanitizePlayerMovement(
    incoming,
    previous
) {

    if (
        !incoming ||
        typeof incoming !== "object"
    ) {

        return previous;
    }


    const x =
        clamp(
            numberOr(
                incoming.x,
                previous.x
            ),
            45,
            WORLD_W - 45
        );


    const y =
        clamp(
            numberOr(
                incoming.y,
                previous.y
            ),
            45,
            WORLD_H - 45
        );


    const rotation =
        numberOr(
            incoming.rotation,
            previous.rotation
        );


    const weaponIndex =
        Math.floor(
            clamp(
                numberOr(
                    incoming.weaponIndex,
                    previous.weaponIndex
                ),
                0,
                3
            )
        );


    return {

        x,
        y,
        rotation,

        weaponIndex,

        /*
        Vida/muerte preservadas.
        */

        health:
            previous.health,

        dead:
            previous.dead
    };
}


/* =====================================================
   WORLD STATE
===================================================== */

function sanitizeZombie(
    zombie
) {

    if (
        !zombie ||
        typeof zombie !== "object"
    ) {

        return null;
    }


    return {

        x:
            clamp(
                numberOr(
                    zombie.x,
                    640
                ),
                0,
                WORLD_W
            ),

        y:
            clamp(
                numberOr(
                    zombie.y,
                    360
                ),
                0,
                WORLD_H
            ),

        type:
            [
                "normal",
                "fast",
                "tank"
            ].includes(
                zombie.type
            )
                ? zombie.type
                : "normal",

        radius:
            clamp(
                numberOr(
                    zombie.radius,
                    16
                ),
                5,
                40
            ),

        health:
            Math.max(
                0,
                numberOr(
                    zombie.health,
                    0
                )
            ),

        maxHealth:
            Math.max(
                1,
                numberOr(
                    zombie.maxHealth,
                    100
                )
            ),

        dead:
            Boolean(
                zombie.dead
            )
    };
}


function sanitizeWorldState(
    incoming
) {

    if (
        !incoming ||
        typeof incoming !== "object"
    ) {

        return null;
    }


    const zombies =
        Array.isArray(
            incoming.zombies
        )
            ?
            incoming.zombies
                .slice(0, 150)
                .map(
                    sanitizeZombie
                )
                .filter(Boolean)
            :
            [];


    return {

        wave:
            Math.max(
                0,
                Math.floor(
                    numberOr(
                        incoming.wave,
                        0
                    )
                )
            ),

        score:
            Math.max(
                0,
                Math.floor(
                    numberOr(
                        incoming.score,
                        0
                    )
                )
            ),

        enemiesToSpawn:
            Math.max(
                0,
                Math.floor(
                    numberOr(
                        incoming.enemiesToSpawn,
                        0
                    )
                )
            ),

        zombies
    };
}


/* =====================================================
   PLAYER COUNT
===================================================== */

function emitPlayerCount(
    room
) {

    if (!room) {
        return;
    }


    io.to(room.code)
        .emit(
            "roomPlayers",
            {
                count:
                    room.players.size,

                max:
                    MAX_PLAYERS
            }
        );
}


/* =====================================================
   SOCKET.IO
===================================================== */

io.on(
    "connection",
    socket => {

        console.log(
            "[CONNECT]",
            socket.id
        );


        /* =================================================
           CREATE ROOM
        ================================================= */

        socket.on(
            "createRoom",
            callback => {

                try {

                    /*
                    Si estaba en otra sala,
                    la abandona primero.
                    */

                    leaveCurrentRoom(
                        socket,
                        false
                    );


                    const code =
                        generateRoomCode();


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

                        started:
                            false,

                        worldState: {
                            wave: 0,
                            score: 0,
                            enemiesToSpawn: 0,
                            zombies: []
                        },

                        createdAt:
                            Date.now()
                    };


                    room.playerStates.set(
                        socket.id,
                        createInitialPlayerState(
                            true
                        )
                    );


                    rooms.set(
                        code,
                        room
                    );


                    socket.join(
                        code
                    );


                    socket.data.roomCode =
                        code;


                    socket.data.isHost =
                        true;


                    console.log(
                        "[ROOM CREATED]",
                        code,
                        socket.id
                    );


                    if (
                        typeof callback ===
                        "function"
                    ) {

                        callback({
                            ok: true,
                            code
                        });
                    }


                    emitPlayerCount(
                        room
                    );

                } catch (error) {

                    console.error(
                        "[CREATE ROOM ERROR]",
                        error
                    );


                    if (
                        typeof callback ===
                        "function"
                    ) {

                        callback({
                            ok: false,
                            message:
                                "Could not create room."
                        });
                    }
                }
            }
        );


        /* =================================================
           JOIN ROOM
        ================================================= */

        socket.on(
            "joinRoom",
            (
                requestedCode,
                callback
            ) => {

                try {

                    const code =
                        String(
                            requestedCode || ""
                        )
                        .trim()
                        .toUpperCase();


                    const room =
                        rooms.get(
                            code
                        );


                    if (!room) {

                        if (
                            typeof callback ===
                            "function"
                        ) {

                            callback({
                                ok: false,
                                message:
                                    "Room not found."
                            });
                        }

                        return;
                    }


                    if (
                        room.started
                    ) {

                        if (
                            typeof callback ===
                            "function"
                        ) {

                            callback({
                                ok: false,
                                message:
                                    "Match already started."
                            });
                        }

                        return;
                    }


                    if (
                        room.players.size >=
                        MAX_PLAYERS
                    ) {

                        if (
                            typeof callback ===
                            "function"
                        ) {

                            callback({
                                ok: false,
                                message:
                                    "Room is full."
                            });
                        }

                        return;
                    }


                    leaveCurrentRoom(
                        socket,
                        false
                    );


                    room.players.add(
                        socket.id
                    );


                    room.playerStates.set(
                        socket.id,
                        createInitialPlayerState(
                            false
                        )
                    );


                    socket.join(
                        code
                    );


                    socket.data.roomCode =
                        code;


                    socket.data.isHost =
                        false;


                    console.log(
                        "[ROOM JOIN]",
                        code,
                        socket.id
                    );


                    if (
                        typeof callback ===
                        "function"
                    ) {

                        callback({
                            ok: true,
                            code
                        });
                    }


                    /*
                    Avisar al Host.
                    */

                    socket
                        .to(code)
                        .emit(
                            "playerJoined",
                            {
                                id:
                                    socket.id
                            }
                        );


                    emitPlayerCount(
                        room
                    );

                } catch (error) {

                    console.error(
                        "[JOIN ERROR]",
                        error
                    );


                    if (
                        typeof callback ===
                        "function"
                    ) {

                        callback({
                            ok: false,
                            message:
                                "Could not join room."
                        });
                    }
                }
            }
        );


        /* =================================================
           START MATCH
        ================================================= */

        socket.on(
            "startMatch",
            () => {

                const room =
                    getRoomBySocket(
                        socket
                    );


                if (!room) {
                    return;
                }


                if (
                    !isRoomHost(
                        socket,
                        room
                    )
                ) {

                    return;
                }


                if (
                    room.players.size <
                    2
                ) {

                    return;
                }


                room.started =
                    true;


                /*
                Reiniciamos estado autoritativo.
                */

                for (
                    const playerID
                    of room.players
                ) {

                    room.playerStates.set(
                        playerID,

                        createInitialPlayerState(
                            playerID ===
                            room.host
                        )
                    );
                }


                room.worldState = {
                    wave: 0,
                    score: 0,
                    enemiesToSpawn: 0,
                    zombies: []
                };


                console.log(
                    "[MATCH START]",
                    room.code
                );


                io.to(room.code)
                    .emit(
                        "matchStarted"
                    );
            }
        );


        /* =================================================
           PLAYER MOVEMENT
        ================================================= */

        socket.on(
            "playerState",
            incoming => {

                const room =
                    getRoomBySocket(
                        socket
                    );


                if (
                    !room ||
                    !room.started
                ) {

                    return;
                }


                const previous =
                    room.playerStates.get(
                        socket.id
                    );


                if (!previous) {
                    return;
                }


                /*
                Jugador muerto:
                no permitimos que siga
                desplazándose desde el cliente.

                Sí preservamos el estado.
                */

                let updated;


                if (
                    previous.dead
                ) {

                    updated = {
                        ...previous,

                        rotation:
                            numberOr(
                                incoming?.rotation,
                                previous.rotation
                            ),

                        weaponIndex:
                            previous.weaponIndex
                    };

                } else {

                    updated =
                        sanitizePlayerMovement(
                            incoming,
                            previous
                        );
                }


                room.playerStates.set(
                    socket.id,
                    updated
                );


                /*
                Enviar al OTRO jugador.
                */

                socket
                    .to(room.code)
                    .emit(
                        "remotePlayerState",
                        updated
                    );
            }
        );


        /* =================================================
           CHANGE WEAPON
        ================================================= */

        socket.on(
            "weaponChanged",
            incoming => {

                const room =
                    getRoomBySocket(
                        socket
                    );


                if (
                    !room ||
                    !room.started
                ) {

                    return;
                }


                const state =
                    room.playerStates.get(
                        socket.id
                    );


                if (
                    !state ||
                    state.dead
                ) {

                    return;
                }


                const weaponIndex =
                    Math.floor(
                        clamp(
                            numberOr(
                                incoming?.weaponIndex,
                                state.weaponIndex
                            ),
                            0,
                            3
                        )
                    );


                state.weaponIndex =
                    weaponIndex;


                room.playerStates.set(
                    socket.id,
                    state
                );


                socket
                    .to(room.code)
                    .emit(
                        "remoteWeaponChanged",
                        {
                            weaponIndex
                        }
                    );
            }
        );


        /* =================================================
           SHOOT

           El servidor usa la posición que
           conoce del jugador.

           Así evitamos que el cliente
           invente otro origen.
        ================================================= */

        socket.on(
            "shoot",
            incoming => {

                const room =
                    getRoomBySocket(
                        socket
                    );


                if (
                    !room ||
                    !room.started
                ) {

                    return;
                }


                const state =
                    room.playerStates.get(
                        socket.id
                    );


                if (
                    !state ||
                    state.dead
                ) {

                    return;
                }


                const rotation =
                    numberOr(
                        incoming?.rotation,
                        state.rotation
                    );


                const weaponIndex =
                    Math.floor(
                        clamp(
                            numberOr(
                                incoming?.weaponIndex,
                                state.weaponIndex
                            ),
                            0,
                            3
                        )
                    );


                /*
                Sincronizamos también
                la rotación/arma conocida.
                */

                state.rotation =
                    rotation;


                state.weaponIndex =
                    weaponIndex;


                room.playerStates.set(
                    socket.id,
                    state
                );


                const shot = {

                    x:
                        state.x,

                    y:
                        state.y,

                    rotation,

                    weaponIndex,

                    shooter:
                        socket.id
                };


                /*
                IMPORTANTE:

                No se devuelve al mismo
                jugador porque su index V3
                ya dibuja su bala
                inmediatamente.

                Solo va al compañero.
                */

                socket
                    .to(room.code)
                    .emit(
                        "remoteShoot",
                        shot
                    );
            }
        );


        /* =================================================
           AUTHORITATIVE HEALTH

           SOLO EL HOST puede decidir
           el daño de zombis.
        ================================================= */

        socket.on(
            "authoritativeHealth",
            incoming => {

                const room =
                    getRoomBySocket(
                        socket
                    );


                if (
                    !room ||
                    !room.started
                ) {

                    return;
                }


                if (
                    !isRoomHost(
                        socket,
                        room
                    )
                ) {

                    return;
                }


                if (
                    !incoming ||
                    typeof incoming !==
                    "object"
                ) {

                    return;
                }


                let targetID = null;


                if (
                    incoming.target ===
                    "host"
                ) {

                    targetID =
                        room.host;

                } else if (
                    incoming.target ===
                    "client"
                ) {

                    targetID =
                        [...room.players]
                        .find(
                            id =>
                                id !==
                                room.host
                        )
                        || null;
                }


                if (!targetID) {
                    return;
                }


                const state =
                    room.playerStates.get(
                        targetID
                    );


                if (!state) {
                    return;
                }


                /*
                Vida siempre 0..100.
                */

                const health =
                    clamp(
                        numberOr(
                            incoming.health,
                            state.health
                        ),
                        0,
                        100
                    );


                /*
                Una vez muerto,
                no puede revivir mediante
                un paquete posterior.
                */

                if (
                    state.dead
                ) {

                    state.health = 0;
                    state.dead = true;

                } else {

                    state.health =
                        health;


                    state.dead =
                        health <= 0
                        ||
                        Boolean(
                            incoming.dead
                        );


                    if (
                        state.dead
                    ) {

                        state.health = 0;
                    }
                }


                room.playerStates.set(
                    targetID,
                    state
                );


                /*
                Enviar a LOS DOS.

                De esta forma:

                - el jugador dañado conoce
                  su vida.
                - el compañero conoce que
                  murió.
                - el Host puede seguir
                  simulando aunque él muera.
                */

                io.to(room.code)
                    .emit(
                        "authoritativeHealth",
                        {
                            target:
                                incoming.target,

                            health:
                                state.health,

                            dead:
                                state.dead
                        }
                    );


                console.log(
                    "[HEALTH]",
                    room.code,
                    incoming.target,
                    state.health,
                    state.dead
                        ? "DEAD"
                        : "ALIVE"
                );
            }
        );


        /* =================================================
           WORLD STATE

           SOLO HOST.
        ================================================= */

        socket.on(
            "worldState",
            incoming => {

                const room =
                    getRoomBySocket(
                        socket
                    );


                if (
                    !room ||
                    !room.started
                ) {

                    return;
                }


                if (
                    !isRoomHost(
                        socket,
                        room
                    )
                ) {

                    return;
                }


                const state =
                    sanitizeWorldState(
                        incoming
                    );


                if (!state) {
                    return;
                }


                room.worldState =
                    state;


                /*
                El Host no necesita que
                le devolvamos su mundo.

                Solo Player 2.
                */

                socket
                    .to(room.code)
                    .emit(
                        "worldState",
                        state
                    );
            }
        );


        /* =================================================
           LEAVE ROOM
        ================================================= */

        socket.on(
            "leaveRoom",
            () => {

                leaveCurrentRoom(
                    socket,
                    true
                );
            }
        );


        /* =================================================
           DISCONNECT
        ================================================= */

        socket.on(
            "disconnect",
            reason => {

                console.log(
                    "[DISCONNECT]",
                    socket.id,
                    reason
                );


                leaveCurrentRoom(
                    socket,
                    true
                );
            }
        );
    }
);


/* =====================================================
   LEAVE CURRENT ROOM
===================================================== */

function leaveCurrentRoom(
    socket,
    notify
) {

    const code =
        socket.data.roomCode;


    if (!code) {
        return;
    }


    const room =
        rooms.get(
            code
        );


    socket.leave(
        code
    );


    socket.data.roomCode =
        null;


    socket.data.isHost =
        false;


    if (!room) {
        return;
    }


    const wasHost =
        room.host ===
        socket.id;


    room.players.delete(
        socket.id
    );


    room.playerStates.delete(
        socket.id
    );


    /*
    Si el Host se DESCONECTA de Internet
    o abandona completamente la sala,
    no existe otro dispositivo que pueda
    seguir ejecutando la IA.

    Esto es diferente a MORIR.

    Morir dentro del juego NO cierra
    la sala.
    */

    if (wasHost) {

        if (notify) {

            socket
                .to(code)
                .emit(
                    "roomClosed"
                );
        }


        rooms.delete(
            code
        );


        console.log(
            "[ROOM CLOSED]",
            code
        );


        return;
    }


    /*
    Se fue Player 2.
    */

    if (notify) {

        socket
            .to(code)
            .emit(
                "playerLeft"
            );
    }


    emitPlayerCount(
        room
    );


    console.log(
        "[PLAYER LEFT]",
        code,
        socket.id
    );
}


/* =====================================================
   OLD ROOM CLEANUP
===================================================== */

setInterval(
    () => {

        const now =
            Date.now();


        for (
            const [
                code,
                room
            ]
            of rooms
        ) {

            if (
                now -
                room.createdAt
                >
                ROOM_MAX_AGE
            ) {

                io.to(code)
                    .emit(
                        "roomClosed"
                    );


                rooms.delete(
                    code
                );


                console.log(
                    "[OLD ROOM REMOVED]",
                    code
                );
            }
        }

    },
    1000 * 60 * 10
);


/* =====================================================
   SERVER START
===================================================== */

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "===================================="
        );

        console.log(
            " DEAD ROOMS MOBILE SERVER V3"
        );

        console.log(
            " Port:",
            PORT
        );

        console.log(
            " World:",
            WORLD_W,
            "x",
            WORLD_H
        );

        console.log(
            " Multiplayer: ENABLED"
        );

        console.log(
            "===================================="
        );
    }
);
