function Conversation(public_pem) {
    var conv = this;
    this.public_pem = pim_normalize_public_pem(public_pem);
    this.connection = pim_connection(this.public_pem);
    this.connection.handlers.chat = function(conn,msg) {
        conv.onmessage(msg.text,true);
    }
    this.update_interval = setInterval(function() {
        conv.conversation_el.classList.toggle('ready',conv.connection.state=='ready');
    },1000);

    var conversation_el = document.createElement('conversation');
    var name_el = document.createElement('name');
    var messages_el = document.createElement('messages');
    var input_el = document.createElement('input');
    
    input_el.type = 'text';
    input_el.placeholder = 'Type your message here';
    input_el.addEventListener('keydown',function(e) {
        if(e.keyCode==13) { // Code for return
            var text = input_el.value;
            if(text=='') return; // Don't send empty messages
            input_el.value = '';
            conv.connection.send({type:'chat',text:text});
            conv.onmessage(text,false);
        }
    });
    conversation_el.appendChild(name_el);
    conversation_el.appendChild(messages_el);
    conversation_el.appendChild(input_el);
    document.getElementById('conversations').appendChild(conversation_el); // TODO: remove getElementById
    
    this.messages_el = messages_el; // Used by pim_recv_chat_message
    this.name_el = name_el; // Used by pim_recv_shared
    this.conversation_el = conversation_el;

    // Fetch already known information about this peer
    try { this.shared_update(pim_peer_shared(this.public_pem)); }
    catch(e) {}

    // Fetch chat history with this peer
    pim_peer_history(this.public_pem).slice(-10).forEach(function(msg) {
        conv.add_message(msg);
    });
}
Conversation.prototype.shared_update = function(shared) {
    this.name_el.innerHTML = pim_html_entities(shared.name || 'Unknown');
}
Conversation.prototype.onmessage = function(text,incoming) {
    var msg = {
        text:text,incoming:incoming,time:Date.now()
    };
    this.add_message(msg);
    pim_peer_history(this.public_pem).push(msg);
}
Conversation.prototype.add_message = function(msg) {
    // TODO: display time too
    var message_el = document.createElement('message');
    message_el.innerHTML = pim_html_entities(msg.text);
    message_el.className = msg.incoming?'from':'to';
    message_el.title = new Date(msg.time).toLocaleString()
    // TODO: handle urls, images, videos, emojis
    this.messages_el.appendChild(message_el);
    this.messages_el.scrollBy(0,128); // Fucks up with loadable content sometimes
}


var pim_conversations = {};
function pim_start_conversation(public_pem) {
    public_pem = pim_normalize_public_pem(public_pem);
    if(!public_pem) {
        pim_log('Not a public key');
        return;
    }
    if(public_pem==pim_account.public_pem) {
        pim_log('You cannot converse with yourself');
        return;
    }
    if(pim_conversations[public_pem]) {
        pim_log('You are already conversing with that user');
        return;
    }
    return pim_conversations[public_pem] = new Conversation(public_pem);
}
function pim_peer_history(public_pem) {
    var peer = pim_peer(public_pem);
    if(!peer.history) {
        peer.history = [];
    }
    return peer.history;
}
function pim_peer_shared(public_pem) {
    var peer = pim_peer(public_pem);
    if(!peer.shared) {
        peer.shared = {};
    }
    return peer.shared;
}
