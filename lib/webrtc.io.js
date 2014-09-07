//CLIENT
// This is the actual webrtc object which connects and maintains video stuff

// Fallbacks for vendor-specific variables until the spec is finalized.

var RTCPeerConnection = null;
//var PeerConnection;// = (window.PeerConnection || window.webkitRTCPeerConnection || window.webkitPeerConnection00 ||  window.mozRTCPeerConnection);
var URL = (window.URL || window.webkitURL || window.msURL || window.oURL);
//var getUserMedia = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia);
var nativeRTCIceCandidate = (window.mozRTCIceCandidate || window.RTCIceCandidate);
var nativeRTCSessionDescription = (window.mozRTCSessionDescription || window.RTCSessionDescription); // order is very important: "RTCSessionDescription" defined in Nighly but useless

function maybeFixConfiguration(pcConfig) {
    if (pcConfig == null) {
        return;
    }
    for (var i = 0; i < pcConfig.iceServers.length; i++) {
        if (pcConfig.iceServers[i].hasOwnProperty('urls')){
            pcConfig.iceServers[i]['url'] = pcConfig.iceServers[i]['urls'];
            delete pcConfig.iceServers[i]['urls'];
        }
    }
}

var sdpConstraints = {
    'mandatory': {
        'OfferToReceiveAudio': true,
        'OfferToReceiveVideo': true
    }
};

(function() {
    var mediaConstraints = {};
    mediaConstraints.audio = true;
    mediaConstraints.video = { mandatory: {}, optional: [] };

    if (navigator.mozGetUserMedia) {
        console.log("This appears to be Firefox");

        webrtcDetectedBrowser = "firefox";

        webrtcDetectedVersion = parseInt(navigator.userAgent.match(/Firefox\/([0-9]+)\./)[1], 10);

        // The RTCPeerConnection object.
        RTCPeerConnection = function(pcConfig, pcConstraints) {
            // .urls is not supported in FF yet.
            maybeFixConfiguration(pcConfig);
            return new mozRTCPeerConnection(pcConfig, pcConstraints);
        }

        // The RTCSessionDescription object.
        RTCSessionDescription = mozRTCSessionDescription;

        // The RTCIceCandidate object.
        RTCIceCandidate = mozRTCIceCandidate;

        // Get UserMedia (only difference is the prefix).
        // Code from Adam Barth.
        getUserMedia = navigator.mozGetUserMedia.bind(navigator);
        navigator.getUserMedia = getUserMedia;

        // Fake get{Video,Audio}Tracks
        if (!MediaStream.prototype.getVideoTracks) {
            MediaStream.prototype.getVideoTracks = function() {
                return [];
            };
        }

        if (!MediaStream.prototype.getAudioTracks) {
            MediaStream.prototype.getAudioTracks = function() {
                return [];
            };
        }

    } else if (navigator.webkitGetUserMedia) {
        console.log("This appears to be Chrome");

        webrtcDetectedBrowser = "chrome";
        webrtcDetectedVersion =
            parseInt(navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./)[2], 10);

        if (!webkitMediaStream.prototype.getVideoTracks) {
            webkitMediaStream.prototype.getVideoTracks = function() {
                return this.videoTracks;
            };
            webkitMediaStream.prototype.getAudioTracks = function() {
                return this.audioTracks;
            };
        }

        // The RTCPeerConnection object.
        RTCPeerConnection = function(pcConfig, pcConstraints) {
            // .urls is supported since Chrome M34.
            if (webrtcDetectedVersion < 34) {
                maybeFixConfiguration(pcConfig);
            }
            return new webkitRTCPeerConnection(pcConfig, pcConstraints);
        }

        // Get UserMedia (only difference is the prefix).
        // Code from Adam Barth.
        getUserMedia = navigator.webkitGetUserMedia.bind(navigator);
        navigator.getUserMedia = getUserMedia;

        // New syntax of getXXXStreams method in M26.
        //if (!webkitRTCPeerConnection.prototype.getLocalStreams) {
        //    webkitRTCPeerConnection.prototype.getLocalStreams = function() {
        //        return this.localStreams;
        //    };
        //    webkitRTCPeerConnection.prototype.getRemoteStreams = function() {
        //        return this.remoteStreams;
        //    };
        //}
    }

    var rtc;
    if ('undefined' === typeof module) {
        rtc = this.rtc = {};
    } else {
        rtc = module.exports = {};
    }


    // Holds a connection to the server.
    rtc.socket = null;

    // Holds identity for the client
    rtc._me = null;

    // Holds callbacks for certain events.
    rtc._events = {};

    rtc.on = function(eventName, callback) {
        rtc._events[eventName] = rtc._events[eventName] || [];
        rtc._events[eventName].push(callback);
    };

    rtc.fire = function(eventName, _) {
        var events = rtc._events[eventName];
        var args = Array.prototype.slice.call(arguments, 1);

        if (!events) {
            return;
        }

        for (var i = 0, len = events.length; i < len; i++) {
            events[i].apply(null, args);
        }
    };

    // Holds the STUN/ICE server to use for PeerConnections.
    rtc.SERVER = function() {
        //if (navigator.mozGetUserMedia) {
        //    return {
        //        "iceServers": [{
        //            "url": "stun:23.21.150.121"
        //        }]
        //    };
        //}
        return {
            "iceServers": [{
                "url": "stun:stun.l.google.com:19302"
            }]
        };
    };


    // Reference to the lone PeerConnection instance.
    rtc.peerConnections = {};

    // Array of known peer socket ids
    rtc.connections = [];
    // Stream-related variables.
    rtc.streams = [];
    rtc.numStreams = 0;
    rtc.initializedStreams = 0;


    // Reference to the data channels
    rtc.dataChannels = {};

    // PeerConnection datachannel configuration
    rtc.dataChannelConfig = {
        "optional": [{
           // "RtpDataChannels": true
        }, {
            "DtlsSrtpKeyAgreement": true
        }]
    };

    rtc.pc_constraints = {
        "optional": [{
            "DtlsSrtpKeyAgreement": true
        }]
    };


    // check whether data channel is supported.
    rtc.checkDataChannelSupport = function() {
        try {
            // raises exception if createDataChannel is not supported
            var pc = new RTCPeerConnection(rtc.SERVER(), rtc.dataChannelConfig);
            var channel = pc.createDataChannel('supportCheck', {
                reliable: false
            });
            channel.close();
            return true;
        } catch (e) {
            return false;
        }
    };

    rtc.dataChannelSupport = false; //rtc.checkDataChannelSupport();


    /**
     * Connects to the websocket server.
     */
    rtc.connect = function(server, room) {
        //room = room || ""; // by default, join a room called the blank string
        var socket = rtc.socket = io.connect(server);

        socket.on('connect', function() {
            rtc.fire('connect', socket.socket.sessionid);
        });
        //rtc.io.emit("join_room", { "room": room });

        socket.on('receive_chat_msg', function(data) {
            rtc.fire('receive_chat_msg', data);
        });

        socket.onerror = function(err) {
            console.error('onerror');
            console.error(err);
        };

        socket.onclose = function(data) {
            // App is still open but we've disconnected from the room
            rtc.fire('disconnect stream', socket.id);
            delete rtc.peerConnections[socket.id];
        };

        socket.on('pipeline data', function(data) {
            rtc.fire('pipeline data', data.output);
        });

        socket.on('get_peers', function(data) {
            rtc.connections = data.connections;
            rtc._me = data.you;
            // fire connections event and pass peers
            rtc.fire('connections', rtc.connections);
        });

        socket.on('new_peer_connected', function(data) {
            // A new peer connection has joined the room.

            rtc.connections.push(data.socketId);

            // Construct local representation of newly connected peer.
            // This PeerConnection has been prepped to handle WebRTC
            // events coinciding with the peer adding its own streams.
            var pc = rtc.createPeerConnection(data.socketId);

            // Provide peer with all local streams.
            for (var i = 0; i < rtc.streams.length; i++) {
                var stream = rtc.streams[i];
                pc.addStream(stream);
            }
        });

        socket.on('remove_peer_connected', function(data) {
            rtc.fire('disconnect stream', data.socketId);

            // Deleting
            delete rtc.peerConnections[data.socketId];
        });

        socket.on('receive_offer', function(data) {
            rtc.receiveOffer(data.socketId, data.sdp);
            rtc.fire('receive offer', data);
        });

        socket.on('receive_answer', function(data) {
            rtc.receiveAnswer(data.socketId, data.sdp);
            rtc.fire('receive answer', data);
        });

        socket.on('receive_ice_candidate', function(data) {
            var candidate = new nativeRTCIceCandidate(data);
            rtc.peerConnections[data.socketId].addIceCandidate(candidate);
            rtc.fire('receive ice candidate', candidate);
        });
        //return socket;
    };
    rtc.send = function(eventname, args) {
        rtc.socket.emit(eventname, args);
    };

    //rtc.join = function(room) {
    //    rtc.socket.emit('join_room', {room: room});
    //};

    rtc.join = function(roomReq, callback) {
        if((typeof roomReq) === 'string') {
            rtc.socket.emit('join_room', {room: roomReq, auth:''}, function(err, peerData) {
                if(err) {
                    console.error(err);
                }
                rtc.connections = peerData.connections;
                rtc._me = peerData.you;
                // fire connections event and pass peers
                rtc.fire('connections', rtc.connections);
                rtc.fire('roomready', true);
                if(callback){
                    callback(err, peerData);
                }
            });
        } else {
            var name = roomReq.name;
            var auth = roomReq.auth;
        }
    };

    rtc.leave = function(room) {
        rtc.socket.emit('leave_room', {room: room}, function(err){
            rtc.fire('roomready', false)
        });
    };

    rtc.sendOffers = function() {
        for (var i = 0, len = rtc.connections.length; i < len; i++) {
            var socketId = rtc.connections[i];
            rtc.sendOffer(socketId);
        }
    };

    rtc.onClose = function(data) {
        rtc.on('close_stream', function() {
            rtc.fire('close_stream', data);
        });
    };

    rtc.createPeerConnections = function() {
        for (var i = 0; i < rtc.connections.length; i++) {
            rtc.createPeerConnection(rtc.connections[i]);
        }
    };

    rtc.createPeerConnection = function(id) {

        var config = rtc.pc_constraints;
        if (rtc.dataChannelSupport) config = rtc.dataChannelConfig;

        var pc = rtc.peerConnections[id] = new RTCPeerConnection(rtc.SERVER(), config);
        pc.onicecandidate = function(event) {
            if (event.candidate) {
                rtc.socket.emit("send_ice_candidate", {
                    "label": event.candidate.sdpMLineIndex,
                    "candidate": event.candidate.candidate,
                    "socketId": id
                });
            }
            rtc.fire('ice candidate', event.candidate);
        };

        pc.onaddstream = function(event) {
            // TODO: Finalize this API
            rtc.fire('add remote stream', event.stream, id);
        };

        pc.onremovestream = function(event) {
            rtc.fire('disconnect stream', id);
        };

        pc.onsignalingstatechange = function(event) {
            rtc.fire('signaling state change', event, id);
        };

        pc.oniceconnectionstatechange = function(event) {
            rtc.fire('ice connection state change', event, id);
        };

        pc.onopen = function() {
            // TODO: Finalize this API
            rtc.fire('peer connection opened');
        };

        if (rtc.dataChannelSupport) {
            pc.ondatachannel = function(evt) {
                console.log('data channel connecting ' + id);
                rtc.addDataChannel(id, evt.channel);
            };
        }

        return pc;
    };

    rtc.sendOffer = function(socketId) {
        var pc = rtc.peerConnections[socketId];

        var constraints = {
            "optional": [],
            "mandatory": {
                "MozDontOfferDataChannel": true
            }
        };
        // temporary measure to remove Moz* constraints in Chrome
        if (navigator.webkitGetUserMedia) {
            for (var prop in constraints.mandatory) {
                if (prop.indexOf("Moz") != -1) {
                    delete constraints.mandatory[prop];
                }
            }
        }
        constraints = mergeConstraints(constraints, sdpConstraints);

        pc.createOffer(function(session_description) {
            session_description.sdp = maybePreferAudioReceiveCodec(session_description.sdp);
            pc.setLocalDescription(session_description, function(){
                rtc.socket.emit("send_offer",{
                    "socketId": socketId,
                    "sdp": session_description
                });
            }, onerror);
        }, onerror, constraints);

        function onerror(err) {
            console.error('error with create offer');
            console.error(JSON.stringify(err));
        }
    };


    rtc.receiveOffer = function(socketId, message) {
        // message: {sdp: ..., offer: ... }
        setRemote(socketId, message);
        doAnswer(socketId, message);
    };

    rtc.receiveAnswer = function(socketId, message) {
        // message: {sdp: ..., offer: ... }
        setRemote(socketId, message);
    };

    function setRemote(socketId, message) {
        var pc = rtc.peerConnections[socketId];
        message.sdp = maybePreferAudioSendCodec(message.sdp);
        pc.setRemoteDescription(new RTCSessionDescription(message), onSetRemoteDescriptionSuccess, function(err){
            console.error('setRemote error: ' + err);
        });

        function onSetRemoteDescriptionSuccess() {
            console.log("Set remote session description success.");
            // By now all addstream events for the setRemoteDescription have fired.
            // So we can know if the peer is sending any stream or is only receiving.
            //if (remoteStream) {
            //    waitForRemoteVideo();
            //} else {
            //    console.log("Not receiving any stream.");
            //    transitionToActive();
            //}
        }

    }

    function doAnswer(socketId, sdp) {
        var pc = rtc.peerConnections[socketId];
        pc.createAnswer(function(answer) {
            pc.setLocalDescription(new RTCSessionDescription(answer), function() {
                rtc.socket.emit("send_answer", {
                    "socketId": socketId,
                    "sdp": answer
                });
            }, onerror);
        }, onerror, sdpConstraints);

        function onerror(err) {
            console.error('error with create/send answer');
            console.error(JSON.stringify(err));
        }
    };


    // {{{ Extra functions from code.google.com/p/webrtc
    var remoteStream;
    function waitForRemoteVideo() {
        // Call the getVideoTracks method via adapter.js.
        videoTracks = remoteStream.getVideoTracks();
        if (videoTracks.length === 0 || remoteVideo.currentTime > 0) {
            transitionToActive();
        } else {
            setTimeout(waitForRemoteVideo, 100);
        }
    }

    function transitionToActive() {
        console.log('transition to active');
        //reattachMediaStream(miniVideo, localVideo);
        //remoteVideo.style.opacity = 1;
        //card.style.webkitTransform = 'rotateY(180deg)';
        //setTimeout(function() { localVideo.src = ''; }, 500);
        //setTimeout(function() { miniVideo.style.opacity = 1; }, 1000);
        //// Reset window display according to the asperio of remote video.
        //window.onresize();
        //setStatus('<input type=\'button\' id=\'hangup\' value=\'Hang up\' \
        //        onclick=\'onHangup()\' />');
    }

    function transitionToWaiting() {
        //card.style.webkitTransform = 'rotateY(0deg)';
        //setTimeout(function() {
        //             localVideo.src = miniVideo.src;
        //             miniVideo.src = '';
        //             remoteVideo.src = '' }, 500);
        //miniVideo.style.opacity = 0;
        //remoteVideo.style.opacity = 0;
        //resetStatus();
    }

    function transitionToDone() {

        //localVideo.style.opacity = 0;
        //remoteVideo.style.opacity = 0;
        //miniVideo.style.opacity = 0;
        //setStatus('You have left the call. <a href=' + roomLink + '>\
        //          Click here</a> to rejoin.');
    }
    // }}}



    rtc.createStream = function(opt, onSuccess, onFail) {
        var options;
        onSuccess = onSuccess || function() {};
        onFail = onFail || function() {};

        opt = opt || {};
        options = {
            video: !! opt.video,
            audio: !! opt.audio
        };

        if (getUserMedia) {
            rtc.numStreams++;
            getUserMedia(options, function(stream) {

                rtc.streams.push(stream);
                rtc.initializedStreams++;
                onSuccess(stream);
                if (rtc.initializedStreams === rtc.numStreams) {
                    rtc.fire('streamready', true);
                }
            }, function() {
                //alert("Could not connect stream.");
                onFail("Could not connect stream.");
            });
        } else {
            onFail('webRTC is not yet supported in this browser.');
        }
    };

    rtc.addStreams = function() {
        for (var i = 0; i < rtc.streams.length; i++) {
            var stream = rtc.streams[i];
            for (var connection in rtc.peerConnections) {
                rtc.peerConnections[connection].addStream(stream);
            }
        }
    };

    rtc.attachStream = function(stream, domId) {
        var element = document.getElementById(domId);
        if (navigator.mozGetUserMedia) {
            console.log("Attaching media stream");
            element.mozSrcObject = stream;
            element.play();
        } else {
            if (typeof element.srcObject !== 'undefined') {
                element.srcObject = stream;
            } else if (typeof element.mozSrcObject !== 'undefined') {
                element.mozSrcObject = stream;
            } else if (typeof element.src !== 'undefined') {
                element.src = webkitURL.createObjectURL(stream);
            } else {
                console.log('Error attaching stream to element.');
            }
        }
    };


    rtc.createDataChannel = function(pcOrId, label) {
        if (!rtc.dataChannelSupport) {
            //TODO this should be an exception
            alert('webRTC data channel is not yet supported in this browser,' +
                    ' or you must turn on experimental flags');
            return;
        }

        var id, pc;
        if (typeof(pcOrId) === 'string') {
            id = pcOrId;
            pc = rtc.peerConnections[pcOrId];
        } else {
            pc = pcOrId;
            id = undefined;
            for (var key in rtc.peerConnections) {
                if (rtc.peerConnections[key] === pc) id = key;
            }
        }

        if (!id) throw new Error('attempt to createDataChannel with unknown id');

        //if (!pc || !(pc instanceof RTCPeerConnection)) throw new Error('attempt to createDataChannel without peerConnection');

        // need a label
        label = label || 'fileTransfer' || String(id);

        // chrome only supports reliable false atm.
        var options = {
            reliable: false
        };

        var channel;
        try {
            console.log('createDataChannel ' + id);
            channel = pc.createDataChannel(label, options);
        } catch (error) {
            console.log('seems that DataChannel is NOT actually supported!');
            throw error;
        }

        return rtc.addDataChannel(id, channel);
    };

    rtc.addDataChannel = function(id, channel) {

        channel.onopen = function() {
            console.log('data stream open ' + id);
            rtc.fire('data stream open', channel);
        };

        channel.onclose = function(event) {
            delete rtc.dataChannels[id];
            console.log('data stream close ' + id);
            rtc.fire('data stream close', channel);
        };

        channel.onmessage = function(message) {
            console.log('data stream message ' + id);
            console.log(message);
            rtc.fire('data stream data', channel, message.data);
        };

        channel.onerror = function(err) {
            console.log('data stream error ' + id + ': ' + err);
            rtc.fire('data stream error', channel, err);
        };

        // track dataChannel
        rtc.dataChannels[id] = channel;
        return channel;
    };

    rtc.addDataChannels = function() {
        if (!rtc.dataChannelSupport) return;

        for (var connection in rtc.peerConnections)
            rtc.createDataChannel(connection);
    };

    rtc.checkReady = function() {
        if(rtc.roomReady){// && rtc.streamReady){
            rtc.fire('ready');
        }
    };

    rtc.on('roomready', function(isReady){
        rtc.roomReady = isReady;
        rtc.checkReady();
    });

    rtc.on('streamready', function(isReady){
        rtc.streamReady = isReady;
        rtc.checkReady();
    });

    rtc.on('ready', function() {
        rtc.createPeerConnections();
        rtc.addStreams();
        rtc.addDataChannels();
        rtc.sendOffers();
    });

}).call(this);

function maybePreferAudioSendCodec(sdp) {
    if (audio_send_codec == '') {
        console.log('No preference on audio send codec.');
        return sdp;
    }
    console.log('Prefer audio send codec: ' + audio_send_codec);
    return preferAudioCodec(sdp, audio_send_codec);
}

var audio_receive_codec='';
var audio_send_codec='';
function maybePreferAudioReceiveCodec(sdp) {
    if (audio_receive_codec == '') {
        console.log('No preference on audio receive codec.');
        return sdp;
    }
    console.log('Prefer audio receive codec: ' + audio_receive_codec);
    return preferAudioCodec(sdp, audio_receive_codec);
}

// Set |codec| as the default audio codec if it's present.
// The format of |codec| is 'NAME/RATE', e.g. 'opus/48000'.
function preferAudioCodec(sdp, codec) {
    var fields = codec.split('/');
    if (fields.length != 2) {
        console.log('Invalid codec setting: ' + codec);
        return sdp;
    }
    var name = fields[0];
    var rate = fields[1];
    var sdpLines = sdp.split('\r\n');

    // Search for m line.
    for (var i = 0; i < sdpLines.length; i++) {
        if (sdpLines[i].search('m=audio') !== -1) {
            var mLineIndex = i;
            break;
        }
    }
    if (mLineIndex === null)
        return sdp;

    // If the codec is available, set it as the default in m line.
    for (var i = 0; i < sdpLines.length; i++) {
        if (sdpLines[i].search(name + '/' + rate) !== -1) {
            var regexp = new RegExp(':(\\d+) ' + name + '\\/' + rate, 'i');
            var payload = extractSdp(sdpLines[i], regexp);
            if (payload)
                sdpLines[mLineIndex] = setDefaultCodec(sdpLines[mLineIndex],
                        payload);
            break;
        }
    }

    // Remove CN in m line and sdp.
    sdpLines = removeCN(sdpLines, mLineIndex);

    sdp = sdpLines.join('\r\n');
    return sdp;
}

// Set Opus in stereo if stereo is enabled.
function addStereo(sdp) {
    var sdpLines = sdp.split('\r\n');

    // Find opus payload.
    for (var i = 0; i < sdpLines.length; i++) {
        if (sdpLines[i].search('opus/48000') !== -1) {
            var opusPayload = extractSdp(sdpLines[i], /:(\d+) opus\/48000/i);
            break;
        }
    }

    // Find the payload in fmtp line.
    for (var i = 0; i < sdpLines.length; i++) {
        if (sdpLines[i].search('a=fmtp') !== -1) {
            var payload = extractSdp(sdpLines[i], /a=fmtp:(\d+)/ );
            if (payload === opusPayload) {
                var fmtpLineIndex = i;
                break;
            }
        }
    }
    // No fmtp line found.
    if (fmtpLineIndex === null)
        return sdp;

    // Append stereo=1 to fmtp line.
    sdpLines[fmtpLineIndex] = sdpLines[fmtpLineIndex].concat(' stereo=1');

    sdp = sdpLines.join('\r\n');
    return sdp;
}

function extractSdp(sdpLine, pattern) {
    var result = sdpLine.match(pattern);
    return (result && result.length == 2)? result[1]: null;
}

// Set the selected codec to the first in m line.
function setDefaultCodec(mLine, payload) {
    var elements = mLine.split(' ');
    var newLine = new Array();
    var index = 0;
    for (var i = 0; i < elements.length; i++) {
        if (index === 3) // Format of media starts from the fourth.
            newLine[index++] = payload; // Put target payload to the first.
        if (elements[i] !== payload)
            newLine[index++] = elements[i];
    }
    return newLine.join(' ');
}

// Strip CN from sdp before CN constraints is ready.
function removeCN(sdpLines, mLineIndex) {
    var mLineElements = sdpLines[mLineIndex].split(' ');
    // Scan from end for the convenience of removing an item.
    for (var i = sdpLines.length-1; i >= 0; i--) {
        var payload = extractSdp(sdpLines[i], /a=rtpmap:(\d+) CN\/\d+/i);
        if (payload) {
            var cnPos = mLineElements.indexOf(payload);
            if (cnPos !== -1) {
                // Remove CN payload from m line.
                mLineElements.splice(cnPos, 1);
            }
            // Remove CN line in sdp
            sdpLines.splice(i, 1);
        }
    }

    sdpLines[mLineIndex] = mLineElements.join(' ');
    return sdpLines;
}

function mergeConstraints(cons1, cons2) {
    var merged = cons1;
    for (var name in cons2.mandatory) {
        merged.mandatory[name] = cons2.mandatory[name];
    }
    merged.optional.concat(cons2.optional);
    return merged;
}
