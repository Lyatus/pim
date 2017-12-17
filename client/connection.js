var pim_rtc_conf = {iceServers:[]};

function Connection(id) {
    var conn = this;
    this.state = 'waiting';
    this.authenticated = false;
    this.public_pem = pim_normalize_public_pem(id);
    if(this.public_pem) {
        this.type = 'peer';
    } else { // TODO: check it's a valid url?
        this.type = 'server';
        this.url = id; 
    }
    this.connect();
    this.retry_count = 0;
    this.retry_iterator = 0;
}
Connection.prototype.connect = function() {
    this.state = 'waiting';
    switch(this.type) {
        case 'peer':
            var rtc = this.rtc = new RTCPeerConnection(pim_rtc_conf);
            this.rtc_send = this.rtc.createDataChannel('data');
            this.rtc.conn = this;
            this.rtc.oniceconnectionstatechange = function() {
                if(this.iceConnectionState=='disconnected') {
                    this.conn.state = 'disconnected';
                    pim_log('Disconnected from peer');
                }
            }
            this.rtc.onicecandidate = function(e) {
                if(e.candidate) {
                    pim_log('Sending ICE candidate: '+e.candidate.candidate);
                    pim_send_peer_msg({type:'ice-candidate',to:this.conn.public_pem,candidate:e.candidate});
                }
            }
            this.rtc.ondatachannel = function(e) {
                pim_log("Connection success!");
                this.conn.rtc_recv = e.channel;
                this.conn.rtc_recv.conn = this.conn;
                e.channel.onmessage = function(e) {
                    this.conn.recv(e.data);
                }
                this.conn.state = 'ready';
                pim_share_info(); // TODO: this probably shouldn't be here
            }
            this.rtc.onnegotiationneeded = function() {
                pim_log('Creating offer');
                this.createOffer().then(function(offer) {
                    pim_log('Local offer created');
                    return rtc.setLocalDescription(offer);
                }).then(function() {
                    pim_log('Sending offer');
                    var desc = rtc.localDescription;
                    pim_send_peer_msg({type:'connect-from',to:rtc.conn.public_pem,desc:desc});
                }).catch(pim_log);
            }
            break;
        case 'server':
            this.type = 'server';
            this.websocket = new WebSocket(this.url);
            this.websocket.conn = this;
            this.websocket.onopen = function() {
                pim_log('Connected to: '+this.conn.url);
                this.conn.state = 'ready';
                this.conn.send({type:'auth',public_pem:pim_account.public_pem});
            }
            this.websocket.onclose = function() {
                this.conn.state = 'disconnected';
                pim_log('Disconnected from: '+this.conn.url);
            }
            this.websocket.onerror = function() {
                pim_log('Could not connect to: '+this.conn.url);
            }
            this.websocket.onmessage = function(e) {
                this.conn.recv(e.data);
            }
            break;
    }
}
Connection.prototype.send = function(obj) {
    if(this.state=='ready') {
        var obj_str = JSON.stringify(obj);
        switch(this.type) {
            case 'peer': return this.rtc_send.send(obj_str);
            case 'server': return this.websocket.send(obj_str);
        }
    } else {
        // TODO: put in queue
    }
}
Connection.prototype.recv = function(msg) {
    try { msg = JSON.parse(msg); }
    catch(e) { pim_log(e.message); return; }
    var handler = this.handlers[msg.type];
    if(handler) {
        handler(this,msg);
    } else {
        pim_log('Unhandled message type: '+msg.type)
    }
}
Connection.prototype.handlers = {}
Connection.prototype.handlers['prove-auth'] = function(conn,msg) {
    // Server has sent us an encrypted message we have to decypher to prove our identity
    var decrypted = pim_private_key.decrypt(msg.encrypted,'RSAES-PKCS1-V1_5');
    if(decrypted.substr(0,13)=='----PROOF----') { // Check header so we don't accidentally decipher anything for a server
        conn.send({type:'auth-proof',decrypted:decrypted});
        pim_log('Sending proof to server: '+conn.url);
    } else { // Server is corrupt or buggy?
        conn.close();
        pim_log('Server is corrupt: '+conn.url);
    }
}
Connection.prototype.handlers.authenticated = function(conn,msg) {
    // Server confirmed that we're not authenticated
    conn.authenticated = true;
    pim_log('Authenticated to: '+conn.url);
}
var pim_recvd_peer_msgs = {}; // Hashes of relayed messages received
Connection.prototype.handlers['peer-msg'] = function(conn,msg) {
    var md = forge.md.sha1.create();
    md.update(JSON.stringify(msg.msg), 'utf8');
    var hash = md.digest().toHex();
    if(!pim_recvd_peer_msgs[hash]) { // Ensure we don't receive the same message twice
        pim_recvd_peer_msgs[hash] = true;
        var publicKey = forge.pki.publicKeyFromPem(msg.msg.from);
        if(publicKey.verify(md.digest().bytes(), msg.signature)) { // The message comes from who it says it does
            pim_recv_peer_msg(conn,msg.msg);
        } else {
            pim_log('Received falsified peer message from: '+conn.url);
        }
    }
}

function pim_recv_peer_msg(server,msg) {
    switch(msg.type) {
        case 'connect-from':
            pim_connect_from(msg.from,msg.desc);
            break;
        case 'ice-candidate':
            pim_ice_candidate(msg.from,msg.candidate);
            break;
    }
}
function pim_connect_from(public_pem,remoteDesc) {
    pim_log('Remote offer received');
    var connection = pim_connections[public_pem]
    if(connection) { // Already trying to connect to that user
        pim_log('Was already establishing contact');
        connection.rtc.setRemoteDescription(remoteDesc); // TODO: Check it's a peer connection
    } else { // Unexpected connection attempt
        // TODO: Should ask if user wants to connect in a nice way
        var connection = pim_connection(public_pem); 
        connection.rtc.setRemoteDescription(remoteDesc);
        connection.rtc.createAnswer().then(function(answer) {
            pim_log('Local answer created');
            return connection.rtc.setLocalDescription(answer);
        }).then(function() {
            var desc = connection.rtc.localDescription;
            pim_send_peer_msg({type:'connect-from',to:public_pem,desc:desc});
        });
    }
}
function pim_ice_candidate(public_pem,candidate) {
    var connection = pim_connections[public_pem];
    if(connection) {
        pim_log('Received ICE candidate: '+candidate.candidate);
        connection.rtc.addIceCandidate(new RTCIceCandidate(candidate)); // TODO: more checks
    } else {
        pim_log('Received ICE candidate for unwanted connection');
    }
}
function pim_send_peer_msg(msg) {
    msg.from = pim_account.public_pem;
    var publicKey = forge.pki.publicKeyFromPem(msg.to);
    var md = forge.md.sha1.create();
    md.update(JSON.stringify(msg),'utf8');
    // TODO: only broadcast to small reliable subset for efficiency
    pim_server_broadcast({
        type:'peer-msg',
        msg:msg,
        signature:pim_private_key.sign(md)
    });
}

var pim_connections = {};
function pim_connection(id) {
    // TODO: try to normalize id to avoid duplicates
    // Get or create connection to peer/server
    var connection = pim_connections[id];
    if(!connection) {
        connection = new Connection(id);
        pim_connections[id] = connection;
    }
    return connection;
}
function pim_broadcast(obj,cond) {
    for(var i in pim_connections) {
        var connection = pim_connections[i];
        if(!cond || cond(connection)) {
            connection.send(obj);
        }
    }
}
function pim_peer_broadcast(obj) {
    pim_broadcast(obj,function(conn) {
        return conn.type=='peer';
    });
}
function pim_server_broadcast(obj) {
    pim_broadcast(obj,function(conn) {
        return conn.type=='server';
    });
}

// Automatic reconnect interval
setInterval(function() {
    for(var i in pim_connections) {
        var conn = pim_connections[i];
        if(conn.state!='ready') {
            if(++conn.retry_iterator >= Math.pow(2,conn.retry_count)) {
                conn.retry_count = Math.min(conn.retry_count+1,8);
                conn.retry_iterator = 0;
                conn.connect();
            }
        } else {
            conn.retry_count = 0;
            conn.retry_iterator = 0;
        }
    }
},2000);