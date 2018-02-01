var util = require("util");
var Resource = require("./resource");
var fs = require('fs');
var _ = require('lodash');
var request = require("request-promise");
var CookieStorage = require("./cookie-storage");
var RequestJar = require("./jar");

function Session(device, storage, proxy) {
    this.setDevice(device);    
    this.setCookiesStorage(storage);
    if(_.isString(proxy) && !_.isEmpty(proxy))
        this.proxyUrl = proxy;
}

util.inherits(Session, Resource);
module.exports = Session;

var CONSTANTS = require("./constants");
var Account = require('./account');
var Exceptions = require('./exceptions');
var challenge = require('./web/challenge');
var Challenge = challenge.Challenge;
var Request = require('./request');
var Device = require("./device");
var QE = require("./qe");
var Megaphone = require("./megaphone");
var Timeline = require("./feeds/timeline-feed");
var Inbox = require("./feeds/inbox");
var Thread = require("./thread");
var Relationship = require("./relationship");
var Helpers = require("../../helpers");
var emailInbox = require("../../../../emailInbox")
var phoneInbox = require("../../../../phoneInbox")

Object.defineProperty(Session.prototype, "jar", {
    get: function() { return this._jar },
    set: function(val) {}
});


Object.defineProperty(Session.prototype, "cookieStore", {
    get: function() { return this._cookiesStore },
    set: function(val) {}
});


Object.defineProperty(Session.prototype, "device", {
    get: function() { return this._device },
    set: function(val) {}
});


Object.defineProperty(Session.prototype, "CSRFToken", {
    get: function() { 
        var cookies = this.jar.getCookies(CONSTANTS.HOST) 
        var item = _.find(cookies, { key: "csrftoken" });
        return item ? item.value : "missing";
    },
    set: function(val) {}
});

Object.defineProperty(Session.prototype, "proxyUrl", {
    get: function() { 
        return this._proxyUrl;
    },
    set: function (val) {
        if (!Helpers.isValidUrl(val) && val !== null)
            throw new Error("`proxyUrl` argument is not an valid url")
        this._proxyUrl = val;
    }
});


Session.prototype.setCookiesStorage = function (storage) {
    if(!(storage instanceof CookieStorage))
        throw new Error("`storage` is not an valid instance of `CookieStorage`");
    this._cookiesStore = storage;
    this._jar = new RequestJar(storage.store);
    return this;
};


Session.prototype.setDevice = function (device) {
    if(!(device instanceof Device))
        throw new Error("`device` is not an valid instance of `Device`");
    this._device = device;
    return this;
};


Session.prototype.getAccountId = function() {
    var that = this;
    return this._cookiesStore.getSessionId()
        .then(function () {
            return that._cookiesStore.getAccountId();
        })
}


Session.prototype.setProxy = function(url) {
    this.proxyUrl = url;
    return this;
}


Session.prototype.getAccount = function () {
    var that = this;
    return that.getAccountId()
        .then(function(id){
            return Account.getById(that, id);
        })
};


Session.prototype.destroy = function () {
    var that = this;
    return new Request(this)
        .setMethod('POST')
        .setResource('logout')
        .generateUUID()
        .send()
        .then(function (response) {
          that._cookiesStore.destroy();
          delete that._cookiesStore;
          return response;
        })
};


Session.login = function(session, username, password) {
    return new Request(session)
        .setResource('login')
        .setMethod('POST')
        .generateUUID()
        .setData({
            username: username,
            password: password,
            login_attempt_count: 0
        })
        .signPayload()
        .send()
        .catch(function (error) {
            if (error.name == "RequestError" && _.isObject(error.json)) {
                if(error.json.invalid_credentials)
                    throw new Exceptions.AuthenticationError(error.message);
                if(error.json.error_type==="inactive user")
                    throw new Exceptions.AccountBanned(error.json.message+' '+error.json.help_url);
            }
            throw error;
        })
        .then(function () {
            return [session, QE.sync(session)];
        })
        .spread(function (session) {
            var autocomplete = Relationship.autocompleteUserList(session)
                .catch(Exceptions.RequestsLimitError, function() {
                    // autocompleteUserList has ability to fail often
                    return false;
                })
            return [session, autocomplete];
        })
        .spread(function (session) {
            return [session, new Timeline(session).get()];
        })
        .spread(function (session) {
            return [session, Thread.recentRecipients(session)];
        })
        .spread(function (session) {
            return [session, new Inbox(session).get()];
        })
        .spread(function (session) {
            return [session, Megaphone.logSeenMainFeed(session)];
        })
        .spread(function(session) {
            return session;
        })
        .catch(Exceptions.CheckpointError, function(error) {
            // This situation is not really obvious,
            // but even if you got checkpoint error (aka captcha or phone)
            // verification, it is still an valid session unless `sessionid` missing
            return session.getAccountId()
                .then(function () {
                    // We got sessionId and accountId, we are good to go 
                    return session; 
                })
                .catch(Exceptions.CookieNotValidError, function (e) {
                    throw error;
                })
        })
        
}

Session.create = function(device, storage, username, password, proxy, email, emailPassword, phone) {
    var that = this;
    var session = new Session(device, storage);
    if(_.isString(proxy) && !_.isEmpty(proxy))
        session.proxyUrl = proxy;
    return session.getAccountId()
        .then(function () {
            return session;
        })
        .catch(Exceptions.CookieNotValidError, function() {
            // We either not have valid cookes or authentication is not fain!
            return Session.login(session, username, password)
        })
        .catch(Exceptions.CheckpointError, function(error){
            console.log("⚠️  Oh fuck! challenge detected.");
                return Challenge.resolve(error).then(function(challenge){

                    console.log("challenge type ❓❓❓  " + challenge.type);
                    if (challenge.type == 'phone') {
                        return phoneChallengeResolver(challenge, email, emailPassword, phone)
                    } else if (challenge.type == 'email') {
                        return emailChallengeResolver(challenge, email, emailPassword, phone)
                    } else {
                        return Promise.reject(new Error("Challenge not implemented"))
                    }
                })
        })
}

function phoneChallengeResolver(challenge, email, emailPassword, phone){
    console.log("📱 Phone challenge accepted!");
    return phoneInbox().getPhones()
        .then((phones) => phones[Math.floor(Math.random() * phones.length)])
        .then(function (phoneNumber) {
            console.log(">> Entro con phone ",+phoneNumber)
            //console.log(">> Entro con challenge " + util.inspect(challenge, { showHidden: false, depth: null }));
            return challenge.phone(phoneNumber).
                            then(function(challenge){
                                setTimeout(function(){
                                    console.log(">> Entro con challenge " + util.inspect(challenge, { showHidden: false, depth: null }));
                                    console.log()
                                    console.log("Resolving Challenge...🕺 🕺 🕺")
                                    phoneInbox().getLastVerificationCode(phoneNumber)
                                        .then(verificationCode => challenge.code(verificationCode))
                                }, 1500)
                            }) 
        })
}

function emailChallengeResolver(challenge, email, emailPassword, phone){
    console.log("📧  Email challenge accepted!");
    return emailInbox(email,emailPassword).getLastVerificationCode()
        .then(verificationCode => {
            console.log("🙌 Resolving Challenge... "+verificationCode+" 💃 💃 💃")
            return challenge.code(verificationCode)
        })
}

