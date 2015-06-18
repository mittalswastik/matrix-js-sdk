"use strict";
/**
 * This is an internal module. See {@link MatrixClient} for the public class.
 * @module client
 */
var EventEmitter = require("events").EventEmitter;

var httpApi = require("./http-api");
var MatrixEvent = require("./models/event").MatrixEvent;
var EventStatus = require("./models/event").EventStatus;
var Room = require("./models/room");
var User = require("./models/user");
var utils = require("./utils");

// TODO:
// Internal: rate limiting

/**
 * Construct a Matrix Client. Only directly construct this if you want to use
 * custom modules. Normally, {@link createClient} should be used
 * as it specifies 'sensible' defaults for these modules.
 * @constructor
 * @extends {external:EventEmitter}
 * @param {Object} opts The configuration options for this client.
 * @param {string} opts.baseUrl Required. The base URL to the client-server
 * HTTP API.
 * @param {Function} opts.request Required. The function to invoke for HTTP
 * requests. The value of this property is typically <code>require("request")
 * </code> as it returns a function which meets the required interface. See
 * {@link requestFunction} for more information.
 * @param {string} opts.accessToken The access_token for this user.
 * @param {string} opts.userId The user ID for this user.
 * @param {Object} opts.store Optional. The data store to use. If not specified,
 * this client will not store any HTTP responses.
 * @param {Object} opts.scheduler Optional. The scheduler to use. If not
 * specified, this client will not retry requests on failure.
 */
function MatrixClient(opts) {
    utils.checkObjectHasKeys(opts, ["baseUrl", "request"]);
    utils.checkObjectHasNoAdditionalKeys(opts,
        ["baseUrl", "request", "accessToken", "userId", "store", "scheduler"]
    );

    this.store = opts.store;
    this.scheduler = opts.scheduler;
    // track our position in the overall eventstream
    this.fromToken = undefined;
    this.clientRunning = false;

    var httpOpts = {
        baseUrl: opts.baseUrl,
        accessToken: opts.accessToken,
        request: opts.request,
        prefix: httpApi.PREFIX_V1,
        onlyData: true
    };
    this.credentials = {
        userId: (opts.userId || null)
    };
    this._http = new httpApi.MatrixHttpApi(httpOpts);
}
utils.inherits(MatrixClient, EventEmitter);

/**
 * Get the room for the given room ID.
 * @param {string} roomId The room ID
 * @return {Room} The Room or null if it doesn't exist or there is no data store.
 */
MatrixClient.prototype.getRoom = function(roomId) {
    if (!this.store) {
        return null;
    }
    return this.store.getRoom(roomId);
};

/**
 * Retrieve all known rooms.
 * @return {Room[]} A list of rooms, or an empty list if there is no data store.
 */
MatrixClient.prototype.getRooms = function() {
    if (!this.store) {
        return [];
    }
    return this.store.getRooms();
};

// Room operations
// ===============

/**
 * Create a new room.
 * @param {Object} options a list of options to pass to the /createRoom API.
 * @param {string} options.room_alias_name The alias localpart to assign to
 * this room.
 * @param {string} options.visibility Either 'public' or 'private'.
 * @param {string[]} options.invite A list of user IDs to invite to this room.
 * @param {string} options.name The name to give this room.
 * @param {string} options.topic The topic to give this room.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: <code>{room_id: {string},
 * room_alias: {string(opt)}}</code>
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.createRoom = function(options, callback) {
    // valid options include: room_alias_name, visibility, invite
    return this._http.authedRequest(
        callback, "POST", "/createRoom", undefined, options
    );
};

/**
 * Join a room.
 * @param {string} roomIdOrAlias The room ID or room alias to join.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: <code>{room_id: {string}}</code>
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.joinRoom = function(roomIdOrAlias, callback) {
    var path = utils.encodeUri("/join/$roomid", { $roomid: roomIdOrAlias});
    return this._http.authedRequest(callback, "POST", path, undefined, {});
};

/**
 * @param {string} roomId
 * @param {string} name
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setRoomName = function(roomId, name, callback) {
    return this.sendStateEvent(roomId, "m.room.name", {name: name},
                               undefined, callback);
};

/**
 * @param {string} roomId
 * @param {string} topic
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setRoomTopic = function(roomId, topic, callback) {
    return this.sendStateEvent(roomId, "m.room.topic", {topic: topic},
                               undefined, callback);
};

/**
 * Set a user's power level.
 * @param {string} roomId
 * @param {string} userId
 * @param {Number} powerLevel
 * @param {Object} event
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setPowerLevel = function(roomId, userId, powerLevel,
                                                event, callback) {
    var content = {
        users: {}
    };
    if (event && event.type === "m.room.power_levels") {
        content = event.content;
    }
    content.users[userId] = powerLevel;
    var path = utils.encodeUri("/rooms/$roomId/state/m.room.power_levels", {
        $roomId: roomId
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, content
    );
};

/**
 * Retrieve a state event.
 * @param {string} roomId
 * @param {string} eventType
 * @param {string} stateKey
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.getStateEvent = function(roomId, eventType, stateKey, callback) {
    var pathParams = {
        $roomId: roomId,
        $eventType: eventType,
        $stateKey: stateKey
    };
    var path = utils.encodeUri("/rooms/$roomId/state/$eventType", pathParams);
    if (stateKey !== undefined) {
        path = utils.encodeUri(path + "/$stateKey", pathParams);
    }
    return this._http.authedRequest(
        callback, "GET", path
    );
};

/**
 * @param {string} roomId
 * @param {string} eventType
 * @param {Object} content
 * @param {string} stateKey
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendStateEvent = function(roomId, eventType, content, stateKey, 
                                                 callback) {
    var pathParams = {
        $roomId: roomId,
        $eventType: eventType,
        $stateKey: stateKey
    };
    var path = utils.encodeUri("/rooms/$roomId/state/$eventType", pathParams);
    if (stateKey !== undefined) {
        path = utils.encodeUri(path + "/$stateKey", pathParams);
    }
    return this._http.authedRequest(
        callback, "PUT", path, undefined, content
    );
};

/**
 * @param {string} roomId
 * @param {string} eventType
 * @param {Object} content
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendEvent = function(roomId, eventType, content, txnId,
                                            callback) {
    if (utils.isFunction(txnId)) { callback = txnId; txnId = undefined; }

    if (!txnId) {
        txnId = "m" + new Date().getTime();
    }

    var path = utils.encodeUri("/rooms/$roomId/send/$eventType/$txnId", {
        $roomId: roomId,
        $eventType: eventType,
        $txnId: txnId
    });

    // add this event immediately to the local store as 'sending'.
    // NB: Don't need to check for this.store since getRoom does.
    var room = this.getRoom(roomId);
    var localEvent = null;
    if (room) {
        localEvent = new MatrixEvent({
            event_id: "~" + roomId + ":" + txnId,
            user_id: this.credentials.userId,
            room_id: roomId,
            type: "m.room.message",
            origin_server_ts: new Date().getTime(),
            content: content
        });
        localEvent.status = EventStatus.SENDING;
        room.addEventsToTimeline([localEvent]);
    }
    return this._http.authedRequest(
        callback, "PUT", path, undefined, content
    ).then(function(res) {
        if (room && localEvent) {
            var eventId = res.event_id;
            // try to find an event with this event_id. If we find it, this is
            // the echo of this event *from the event stream* so we can remove
            // the fake event we made above. If we don't find it, we're still
            // waiting on the fake event and so should assign the fake event
            // with the real event_id for matching later.
            var matchingEvent = utils.findElement(room.timeline, function(ev) {
                return ev.getId() === eventId;
            }, true);
            if (matchingEvent) {
                utils.removeElement(room.timeline, function(ev) {
                    return ev.getId() === localEvent.getId();
                }, true);
            }
            else {
                localEvent.event.event_id = res.event_id;
                localEvent.status = null;
            }
        }
    }, function(err) {
        if (localEvent) {
            localEvent.status = EventStatus.NOT_SENT;
        }
    });
};

/**
 * @param {string} roomId
 * @param {Object} content
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendMessage = function(roomId, content, txnId, callback) {
    if (utils.isFunction(txnId)) { callback = txnId; txnId = undefined; }
    return this.sendEvent(
        roomId, "m.room.message", content, txnId, callback
    );
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendTextMessage = function(roomId, body, txnId, callback) {
    var content = {
         msgtype: "m.text",
         body: body
    };
    return this.sendMessage(roomId, content, txnId, callback);
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} txnId Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendEmoteMessage = function(roomId, body, txnId, callback) {
    var content = {
         msgtype: "m.emote",
         body: body
    };
    return this.sendMessage(roomId, content, txnId, callback);
};

/**
 * @param {string} roomId
 * @param {string} url
 * @param {Object} info
 * @param {string} text
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendImageMessage = function(roomId, url, info, text, callback) {
    if (utils.isFunction(text)) { callback = text; text = undefined; }
    if (!text) { text = "Image"; }
    var content = {
         msgtype: "m.image",
         url: url,
         info: info,
         body: text
    };
    return this.sendMessage(roomId, content, callback);
};

/**
 * @param {string} roomId
 * @param {string} body
 * @param {string} htmlBody
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendHtmlMessage = function(roomId, body, htmlBody, callback) {
    var content = {
        msgtype: "m.text",
        format: "org.matrix.custom.html",
        body: body,
        formatted_body: htmlBody
    };
    return this.sendMessage(roomId, content, callback);
};

/**
 * @param {string} roomId
 * @param {boolean} isTyping
 * @param {Number} timeoutMs
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.sendTyping = function(roomId, isTyping, timeoutMs, callback) {
    var path = utils.encodeUri("/rooms/$roomId/typing/$userId", {
        $roomId: roomId,
        $userId: this.credentials.userId
    });
    var data = {
        typing: isTyping
    };
    if (isTyping) {
        data.timeout = timeoutMs ? timeoutMs : 20000;
    }
    return this._http.authedRequest(
        callback, "PUT", path, undefined, data
    );
};

/**
 * @param {string} roomId
 * @param {string} eventId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.redactEvent = function(roomId, eventId, callback) {
    var path = utils.encodeUri("/rooms/$roomId/redact/$eventId", {
        $roomId: roomId,
        $eventId: eventId
    });
    return this._http.authedRequest(callback, "POST", path, undefined, {});
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.invite = function(roomId, userId, callback) {
    return _membershipChange(this, roomId, userId, "invite", undefined,
        callback);
};

/**
 * @param {string} roomId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.leave = function(roomId, callback) {
    return _membershipChange(this, roomId, undefined, "leave", undefined,
        callback);
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {string} reason Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.ban = function(roomId, userId, reason, callback) {
    return _membershipChange(this, roomId, userId, "ban", reason,
        callback);
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.unban = function(roomId, userId, callback) {
    // unbanning = set their state to leave
    return _setMembershipState(
        this, roomId, userId, "leave", undefined, callback
    );
};

/**
 * @param {string} roomId
 * @param {string} userId
 * @param {string} reason Optional.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.kick = function(roomId, userId, reason, callback) {
    return _setMembershipState(
        this, roomId, userId, "leave", reason, callback
    );
};

/**
 * This is an internal method.
 * @param {MatrixClient} client
 * @param {string} roomId
 * @param {string} userId
 * @param {string} membershipValue
 * @param {string} reason
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
function _setMembershipState(client, roomId, userId, membershipValue, reason, 
                             callback) {
    if (utils.isFunction(reason)) { callback = reason; reason = undefined; }

    var path = utils.encodeUri(
        "/rooms/$roomId/state/m.room.member/$userId",
        { $roomId: roomId, $userId: userId}
    );

    return client._http.authedRequest(callback, "PUT", path, undefined, {
        membership: membershipValue,
        reason: reason
    });
}

/**
 * This is an internal method.
 * @param {MatrixClient} client
 * @param {string} roomId
 * @param {string} userId
 * @param {string} membership
 * @param {string} reason
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
function _membershipChange(client, roomId, userId, membership, reason, callback) {
    if (utils.isFunction(reason)) { callback = reason; reason = undefined; }

    var path = utils.encodeUri("/rooms/$room_id/$membership", {
        $room_id: roomId,
        $membership: membership
    });
    return client._http.authedRequest(
        callback, "POST", path, undefined, {
            user_id: userId,  // may be undefined e.g. on leave
            reason: reason
        }
    );
}

// Profile operations
// ==================

/**
 * @param {string} userId
 * @param {string} info The kind of info to retrieve (e.g. 'displayname',
 * 'avatar_url').
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.getProfileInfo = function(userId, info, callback) {
    if (utils.isFunction(info)) { callback = info; info = undefined; }

    var path = info ?
    utils.encodeUri("/profile/$userId/$info",
             { $userId: userId, $info: info }) :
    utils.encodeUri("/profile/$userId",
             { $userId: userId });
    return this._http.authedRequest(callback, "GET", path);
};

/**
 * @param {string} info The kind of info to set (e.g. 'avatar_url')
 * @param {Object} data The JSON object to set.
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setProfileInfo = function(info, data, callback) {
    var path = utils.encodeUri("/profile/$userId/$info", {
        $userId: this.credentials.userId,
        $info: info
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, data
    );
};

/**
 * @param {string} name
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setDisplayName = function(name, callback) {
    return this.setProfileInfo(
        "displayname", { displayname: name }, callback
    );
};

/**
 * @param {string} url
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.setAvatarUrl = function(url, callback) {
    return this.setProfileInfo(
        "avatar_url", { avatar_url: url }, callback
    );
};

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.getThreePids = function(callback) {
    var path = "/account/3pid";
    return this._http.authedRequestWithPrefix(
        callback, "GET", path, undefined, undefined, httpApi.PREFIX_V2_ALPHA
    );
};

/**
 * @param {Object} creds
 * @param {boolean} bind
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.addThreePid = function(creds, bind, callback) {
    var path = "/account/3pid";
    var data = {
        'threePidCreds': creds,
        'bind': bind
    };
    return this._http.authedRequestWithPrefix(
        callback, "POST", path, null, data, httpApi.PREFIX_V2_ALPHA
    );
};

/**
 * @param {string} presence
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 * @throws If 'presence' isn't a valid presence enum value.
 */
MatrixClient.prototype.setPresence = function(presence, callback) {
    var path = utils.encodeUri("/presence/$userId/status", {
        $userId: this.credentials.userId
    });
    var validStates = ["offline", "online", "unavailable"];
    if (validStates.indexOf(presence) == -1) {
        throw new Error("Bad presence value: " + presence);
    }
    var content = {
        presence: presence
    };
    return this._http.authedRequest(
        callback, "PUT", path, undefined, content
    );
};

// Public (non-authed) operations
// ==============================

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.publicRooms = function(callback) {
    return this._http.request(callback, "GET", "/publicRooms");
};

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.registerFlows = function(callback) {
    return this._http.request(callback, "GET", "/register");
};

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.loginFlows = function(callback) {
    return this._http.request(callback, "GET", "/login");
};

/**
 * @param {string} roomAlias
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.resolveRoomAlias = function(roomAlias, callback) {
    var path = utils.encodeUri("/directory/room/$alias", {$alias: roomAlias});
    return this._http.request(callback, "GET", path);
};

/**
 * @param {string} roomId
 * @param {Number} limit
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.roomInitialSync = function(roomId, limit, callback) {
    if (utils.isFunction(limit)) { callback = limit; limit = undefined; }
    var path = utils.encodeUri("/rooms/$roomId/initialSync",
        {$roomId: roomId}
    );
    if (!limit) {
        limit = 30;
    }
    return this._http.authedRequest(
        callback, "GET", path, { limit: limit }
    );
};

/**
 * @param {string} roomId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.roomState = function(roomId, callback) {
    var path = utils.encodeUri("/rooms/$roomId/state", {$roomId: roomId});
    return this._http.authedRequest(callback, "GET", path);
};

/**
 * @param {string} roomId
 * @param {string} from
 * @param {Number} limit
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.scrollback = function(roomId, from, limit, callback) {
    if (utils.isFunction(limit)) { callback = limit; limit = undefined; }
    var path = utils.encodeUri("/rooms/$roomId/messages", {$roomId: roomId});
    if (!limit) {
        limit = 30;
    }
    var params = {
        from: from,
        limit: limit,
        dir: 'b'
    };
    return this._http.authedRequest(callback, "GET", path, params);
};

// Registration/Login operations
// =============================

/**
 * @param {string} loginType
 * @param {Object} data
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.login = function(loginType, data, callback) {
    data.type = loginType;
    return this._http.authedRequest(
        callback, "POST", "/login", undefined, data
    );
};

/**
 * @param {string} loginType
 * @param {Object} data
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.register = function(loginType, data, callback) {
    data.type = loginType;
    return this._http.authedRequest(
        callback, "POST", "/register", undefined, data
    );
};

/**
 * @param {string} user
 * @param {string} password
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.loginWithPassword = function(user, password, callback) {
    return this.login("m.login.password", {
        user: user,
        password: password
    }, callback);
};

// Push operations
// ===============

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.pushRules = function(callback) {
    return this._http.authedRequest(callback, "GET", "/pushrules/");
};

/**
 * @param {string} scope
 * @param {string} kind
 * @param {string} ruleId
 * @param {Object} body
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.addPushRule = function(scope, kind, ruleId, body, callback) {
    // NB. Scope not uri encoded because devices need the '/'
    var path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
        $kind: kind,
        $ruleId: ruleId
    });
    return this._http.authedRequest(
        callback, "PUT", path, undefined, body
    );
};

/**
 * @param {string} scope
 * @param {string} kind
 * @param {string} ruleId
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.deletePushRule = function(scope, kind, ruleId, callback) {
    // NB. Scope not uri encoded because devices need the '/'
    var path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
        $kind: kind,
        $ruleId: ruleId
    });
    return this._http.authedRequest(callback, "DELETE", path);
};

// VoIP operations
// ===============

/**
 * @param {module:client.callback} callback Optional.
 * @return {module:client.Promise} Resolves: TODO
 * @return {module:http-api.MatrixError} Rejects: with an error response.
 */
MatrixClient.prototype.turnServer = function(callback) {
    return this._http.authedRequest(callback, "GET", "/voip/turnServer");
};

/**
 * @return {boolean} true if there is a valid access_token for this client.
 */
MatrixClient.prototype.isLoggedIn = function() {
    return this._http.opts.accessToken !== undefined;
};






// Higher level APIs
// =================

// TODO: stuff to handle:
//   local echo
//   event dup suppression? - apparently we should still be doing this
//   tracking current display name / avatar per-message
//   pagination
//   re-sending (including persisting pending messages to be sent)
//   - Need a nice way to callback the app for arbitrary events like
//     displayname changes
//   due to ambiguity (or should this be on a chat-specific layer)?
//   reconnect after connectivity outages

/**
 * High level helper method to call initialSync, emit the resulting events,
 * and then start polling the eventStream for new events. To listen for these
 * events, add a listener for {@link module:client~MatrixClient#event:"event"}
 * via {@link module:client~MatrixClient#on}.
 * @param {Number} historyLen amount of historical timeline events to
 * emit during from the initial sync. Default: 12.
 */
MatrixClient.prototype.startClient = function(historyLen) {
    if (this.clientRunning) {
        // client is already running.
        return;
    }
    if (this.fromToken) {
        // resume from where we left off.
        _pollForEvents(this);
        return;
    }

    var self = this;
    this._http.authedRequest(
        undefined, "GET", "/initialSync", { limit: (historyLen || 12) }
    ).done(function(data) {
        var i, j;
        // intercept the results and put them into our store
        if (self.store) {
            var eventMapper = function(event) {
                return new MatrixEvent(event);
            };
            utils.forEach(utils.map(data.presence, eventMapper), function(e) {
                var user = createNewUser(self, e.getContent().user_id);
                user.setPresenceEvent(e);
                self.store.storeUser(user);
            });
            for (i = 0; i < data.rooms.length; i++) {
                var room = createNewRoom(self, data.rooms[i].room_id);
                if (!data.rooms[i].state) {
                    data.rooms[i].state = [];
                }
                if (data.rooms[i].membership === "invite") {
                    // create fake invite state event (v1 sucks)
                    data.rooms[i].state.push({
                        event_id: "$fake_" + room.roomId,
                        content: {
                            membership: "invite"
                        },
                        state_key: self.credentials.userId,
                        user_id: data.rooms[i].inviter,
                        room_id: room.roomId,
                        type: "m.room.member"
                    });
                }

                // "old" and "current" state are the same initially; they
                // start diverging if the user paginates.
                // We must deep copy otherwise membership changes in old state
                // will leak through to current state!
                var oldStateEvents = utils.map(
                    utils.deepCopy(data.rooms[i].state), eventMapper
                );
                var stateEvents = utils.map(data.rooms[i].state, eventMapper);
                room.oldState.setStateEvents(oldStateEvents);
                room.currentState.setStateEvents(stateEvents);

                // add events to the timeline *after* setting the state
                // events so messages use the right display names. Initial sync
                // returns messages in chronological order, so we need to reverse
                // it to get most recent -> oldest. We need it in that order in
                // order to diverge old/current state correctly.
                room.addEventsToTimeline(
                    utils.map(
                        data.rooms[i].messages ? data.rooms[i].messages.chunk : [],
                        eventMapper
                    ).reverse(), true
                );

                // cache the name/summary/etc prior to storage since we don't
                // know how the store will serialise the Room.
                room.recalculate(self.credentials.userId);

                self.store.storeRoom(room);
            }
        }

        if (data) {
            self.fromToken = data.end;
            var events = [];
            for (i = 0; i < data.presence.length; i++) {
                events.push(new MatrixEvent(data.presence[i]));
            }
            for (i = 0; i < data.rooms.length; i++) {
                if (data.rooms[i].state) {
                    for (j = 0; j < data.rooms[i].state.length; j++) {
                        events.push(new MatrixEvent(data.rooms[i].state[j]));
                    }
                }
                if (data.rooms[i].messages) {
                    for (j = 0; j < data.rooms[i].messages.chunk.length; j++) {
                        events.push(
                            new MatrixEvent(data.rooms[i].messages.chunk[j])
                        );
                    }
                }
            }
            utils.forEach(events, function(e) {
                self.emit("event", e);
            });
        }

        self.clientRunning = true;
        self.emit("syncComplete");
        _pollForEvents(self);
    }, function(err) {
        self.emit("syncError", err);
        // TODO: Retries.
    });
};

/**
 * This is an internal method.
 * @param {MatrixClient} client
 */
function _pollForEvents(client) {
    var self = client;
    if (!client.clientRunning) {
        return;
    }
    client._http.authedRequest(undefined, "GET", "/events", {
        from: client.fromToken,
        timeout: 30000
    }).done(function(data) {
        var events = [];
        if (data) {
            events = utils.map(data.chunk, function(event) {
                return new MatrixEvent(event);
            });
        }
        if (self.store) {
            // bucket events based on room.
            var i = 0;
            var roomIdToEvents = {};
            for (i = 0; i < events.length; i++) {
                var roomId = events[i].getRoomId();
                // possible to have no room ID e.g. for presence events.
                if (roomId) {
                    if (!roomIdToEvents[roomId]) {
                        roomIdToEvents[roomId] = [];
                    }
                    roomIdToEvents[roomId].push(events[i]);
                }
            }
            // add events to room
            var roomIds = utils.keys(roomIdToEvents);
            for (i = 0; i < roomIds.length; i++) {
                var room = self.store.getRoom(roomIds[i]);
                if (!room) {
                    // TODO: whine about this. We got an event for a room
                    // we don't know about (we should really be doing a
                    // roomInitialSync at this point to pull in state).
                    room = createNewRoom(self, roomIds[i]);
                }
                room.addEvents(roomIdToEvents[roomIds[i]], "replace");
                room.recalculate(self.credentials.userId);
            }
        }
        if (data) {
            self.fromToken = data.end;
            utils.forEach(events, function(e) {
                self.emit("event", e);
            });
        }
        _pollForEvents(self);
    }, function(err) {
        self.emit("syncError", err);
        // retry every few seconds
        // FIXME: this should be exponential backoff with an option to nudge
        setTimeout(function() {
            _pollForEvents(self);
        }, 2000);
    });
}

/**
 * High level helper method to stop the client from polling and allow a
 * clean shutdown.
 */
MatrixClient.prototype.stopClient = function() {
    this.clientRunning = false;
    // TODO: f.e. Room => self.store.storeRoom(room) ?
};


function reEmit(reEmitEntity, emittableEntity, eventNames) {
    utils.forEach(eventNames, function(eventName) {
        // setup a listener on the entity (the Room, User, etc) for this event
        emittableEntity.on(eventName, function() {
            // take the args from the listener and reuse them, adding the
            // event name to the arg list so it works with .emit()
            // Transformation Example:
            // listener on "foo" => function(a,b) { ... }
            // Re-emit on "thing" => thing.emit("foo", a, b)
            var newArgs = [eventName];
            for (var i = 0; i < arguments.length; i++) {
                newArgs.push(arguments[i]);
            }
            reEmitEntity.emit.apply(reEmitEntity, newArgs);
        });
    });
}

function createNewUser(client, userId) {
    var user = new User(userId);
    reEmit(client, user, ["User.avatarUrl", "User.displayName", "User.presence"]);
    return user;
}

function createNewRoom(client, roomId) {
    var room = new Room(roomId);
    reEmit(client, room, ["Room.name", "Room.timeline"]);
    client.emit("Room", room);  // emit created room event

    // we need to also re-emit room state and room member events, so hook it up
    // to the client now. We need to add a listener for RoomState.members in
    // order to hook them correctly. (TODO: find a better way?)
    reEmit(client, room.currentState, [
        "RoomState.events", "RoomState.members", "RoomState.newMember"
    ]);
    room.currentState.on("RoomState.newMember", function(event, state, member) {
        reEmit(
            client, member,
            [
                "RoomMember.name", "RoomMember.typing", "RoomMember.powerLevel",
                "RoomMember.membership"
            ]
        );
    });
    return room;
}

/** */
module.exports.MatrixClient = MatrixClient;

// MatrixClient Event JSDocs

/**
 * Fires whenever the SDK receives a new event.
 * @event module:client~MatrixClient#"event"
 * @param {MatrixEvent} event The matrix event which caused this event to fire.
 * @example
 * matrixClient.on("event", function(event){
 *   var sender = event.getSender();
 * });
 */

/**
 * Fires whenever the SDK has a problem syncing. <strong>This event is experimental
 * and may change.</strong>
 * @event module:client~MatrixClient#"syncError"
 * @param {MatrixError} err The matrix error which caused this event to fire.
 * @example
 * matrixClient.on("syncError", function(err){
 *   // update UI to say "Connection Lost"
 * });
 */

/**
 * Fires when the SDK has finished catching up and is now listening for live
 * events. <strong>This event is experimental and may change.</strong>
 * @event module:client~MatrixClient#"syncComplete"
 * @example
 * matrixClient.on("syncComplete", function(){
 *   var rooms = matrixClient.getRooms();
 * });
 */

 /**
 * Fires whenever a new Room is created. This Room will not be fully populated
 * yet (e.g. no members). <strong>This event is experimental and may change.</strong>
 * @event module:client~MatrixClient#"Room"
 * @param {Room} room The newly created room.
 * @example
 * matrixClient.on("Room", function(room){
 *   var roomId = room.roomId;
 * });
 */

// EventEmitter JSDocs

/**
 * The {@link https://nodejs.org/api/events.html|EventEmitter} class.
 * @external EventEmitter
 * @see {@link https://nodejs.org/api/events.html}
 */

/**
 * Adds a listener to the end of the listeners array for the specified event.
 * No checks are made to see if the listener has already been added. Multiple
 * calls passing the same combination of event and listener will result in the
 * listener being added multiple times.
 * @function external:EventEmitter#on
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Alias for {@link external:EventEmitter#on}.
 * @function external:EventEmitter#addListener
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Adds a <b>one time</b> listener for the event. This listener is invoked only
 * the next time the event is fired, after which it is removed.
 * @function external:EventEmitter#once
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Remove a listener from the listener array for the specified event.
 * <b>Caution:</b> changes array indices in the listener array behind the
 * listener.
 * @function external:EventEmitter#removeListener
 * @param {string} event The event to listen for.
 * @param {Function} listener The function to invoke.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Removes all listeners, or those of the specified event. It's not a good idea
 * to remove listeners that were added elsewhere in the code, especially when
 * it's on an emitter that you didn't create (e.g. sockets or file streams).
 * @function external:EventEmitter#removeAllListeners
 * @param {string} event Optional. The event to remove listeners for.
 * @return {EventEmitter} for call chaining.
 */

/**
 * Execute each of the listeners in order with the supplied arguments.
 * @function external:EventEmitter#emit
 * @param {string} event The event to emit.
 * @param {Function} listener The function to invoke.
 * @return {boolean} true if event had listeners, false otherwise.
 */

/**
 * By default EventEmitters will print a warning if more than 10 listeners are
 * added for a particular event. This is a useful default which helps finding
 * memory leaks. Obviously not all Emitters should be limited to 10. This
 * function allows that to be increased. Set to zero for unlimited.
 * @function external:EventEmitter#setMaxListeners
 * @param {Number} n The max number of listeners.
 * @return {EventEmitter} for call chaining.
 */

// MatrixClient Callback JSDocs

/**
 * The standard MatrixClient callback interface. Functions which accept this
 * will specify 2 return arguments. These arguments map to the 2 parameters
 * specified in this callback.
 * @callback module:client.callback
 * @param {Object} err The error value, the "rejected" value or null.
 * @param {Object} data The data returned, the "resolved" value.
 */

 /**
  * {@link https://github.com/kriskowal/q|A promise implementation (Q)}. Functions
  * which return this will specify 2 return arguments. These arguments map to the
  * "onFulfilled" and "onRejected" values of the Promise.
  * @typedef {Object} Promise
  * @static
  * @property {Function} then promise.then(onFulfilled, onRejected, onProgress)
  * @property {Function} catch promise.catch(onRejected)
  * @property {Function} finally promise.finally(callback)
  * @property {Function} done promise.done(onFulfilled, onRejected, onProgress)
  */