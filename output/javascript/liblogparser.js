// Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
// or more contributor license agreements. Licensed under the Elastic License;
// you may not use this file except in compliance with the Elastic License.

var processor = require("processor");
var console = require("console");

var FLAG_FIELD = "log.flags";
var FIELDS_OBJECT = "nwparser";
var FIELDS_PREFIX = FIELDS_OBJECT + ".";

var defaults = {
    debug: false,
    ecs: true,
    rsa: false,
    keep_raw: false,
    tz_offset: 'local',
}

var saved_flags = null;
var debug;
var map_ecs;
var map_rsa;
var keep_raw;
var device;
var tz_offset;

// Register params from configuration.
function register(params) {
    debug = params.debug !== undefined ? params.debug : defaults.debug;
    map_ecs = params.ecs !== undefined ? params.ecs : defaults.ecs;
    map_rsa = params.rsa !== undefined ? params.rsa : defaults.rsa;
    keep_raw = params.keep_raw !== undefined ? params.keep_raw : defaults.keep_raw;
    tz_offset = parse_tz_offset(params.tz_offset !== undefined? params.tz_offset : defaults.tz_offset);
    console.debug("XXX USING OFFSET = " + tz_offset);
    device = new DeviceProcessor();
}

function parse_tz_offset(offset) {
    switch(offset) {
        // local uses the tz offset from the JS VM.
        case 'local':
            var date = new Date();
            console.debug("XXX LOCAL OFFSET = " + date.getTimezoneOffset());
            // Reversing the sign as we the offset from UTC, not to UTC.
            return parse_local_tz_offset(-date.getTimezoneOffset());
        // event uses the tz offset from event.timezone (add_locale processor).
        case 'event':
            return offset;
        // Otherwise a tz offset in the form "[+-][0-9]{4}" is required.
        default:
            var m = offset.match(/^[+-][0-9]{2}:?[0-9]{2}$/);
            if (m == null) {
                throw("bad timezone offset: '" + offset + "'. Must have the form +HH:MM");
            }
            return offset;
    }
}

function parse_local_tz_offset(minutes) {
    var neg = minutes < 0;
    minutes = Math.abs(minutes);
    var min = minutes % 60;
    var hours = Math.floor(minutes / 60);
    var pad2digit = function(n) {
        if (n < 10) { return "0" + n}
        return "" + n;
    }
    return (neg? "-" : "+") + pad2digit(hours) + ":" + pad2digit(min);
}

function process(evt) {
    // Function register is only called by the processor when `params` are set
    // in the processor config.
    if (device === undefined) {
        register(defaults);
    }
    return device.process(evt);
}

function processor_chain(subprocessors) {
    var builder = new processor.Chain();
    for (var i = 0; i < subprocessors.length; i++) {
        builder.Add(subprocessors[i]);
    }
    return builder.Build().Run;
}

function linear_select(subprocessors) {
    return function (evt) {
        var saved_flags = evt.Get(FLAG_FIELD);
        var i;
        for (i = 0; i < subprocessors.length; i++) {
            evt.Delete(FLAG_FIELD);
            if (debug) console.warn("linear_select trying entry " + i);
            subprocessors[i](evt);
            // Dissect processor succeeded?
            if (evt.Get(FLAG_FIELD) == null) break;
            if (debug) console.warn("linear_select failed entry " + i);
        }
        if (saved_flags !== null) {
            evt.Put(FLAG_FIELD, saved_flags);
        }
        if (debug) {
            if (i < subprocessors.length) {
                console.warn("linear_select matched entry " + i);
            } else {
                console.warn("linear_select didn't match");
            }
        }
    }
}

function match(id, src, pattern, on_success) {
    var dissect = new processor.Dissect({
        field: src,
        tokenizer: pattern,
        target_prefix: FIELDS_OBJECT,
        ignore_failure: true,
        overwrite_keys: true,
    });
    return function (evt) {
        var msg = evt.Get(src);
        dissect.Run(evt);
        var failed = evt.Get(FLAG_FIELD) != null;
        if (debug) {
            if (failed) {
                console.debug("dissect fail: " + id + " field:" + src);
            } else {
                console.debug("dissect   OK: " + id + " field:" + src);
            }
            console.debug("        expr: <<" + pattern + ">>");
            console.debug("       input: <<" + msg + ">>");
        }
        if (on_success != null && !failed) {
            on_success(evt);
        }
    }
}

function all_match(opts) {
    return function (evt) {
        var i;
        for (i = 0; i < opts.processors.length; i++) {
            evt.Delete(FLAG_FIELD);
            // TODO: What if dissect sets FLAG_FIELD? :)
            opts.processors[i](evt);
            // Dissect processor succeeded?
            if (evt.Get(FLAG_FIELD) != null) {
                if (debug) console.warn("all_match failure at " + i);
                if (opts.on_failure != null) opts.on_failure(evt);
                return;
            }
            if (debug) console.warn("all_match success at " + i);
        }
        if (opts.on_success != null) opts.on_success(evt);
    }
}

function msgid_select(mapping) {
    return function (evt) {
        var msgid = evt.Get(FIELDS_PREFIX + "messageid");
        if (msgid == null) {
            if (debug) console.warn("msgid_select: no messageid captured!")
            return;
        }
        var next = mapping[msgid];
        if (next === undefined) {
            if (debug) console.warn("msgid_select: no mapping for messageid:" + msgid);
            return;
        }
        if (debug) console.info("msgid_select: matched key=" + msgid);
        return next(evt);
    }
}

function msg(msg_id, match) {
    return function (evt) {
        match(evt);
        if (evt.Get(FLAG_FIELD) == null) {
            evt.Put(FIELDS_PREFIX + "msg_id1", msg_id);
        }
    }
}

var start;

function save_flags(evt) {
    saved_flags = evt.Get(FLAG_FIELD);
    evt.Put("event.original", evt.Get("message"));
}

function restore_flags(evt) {
    if (saved_flags !== null) {
        evt.Put(FLAG_FIELD, saved_flags);
    }
}

function constant(value) {
    return function (evt) {
        return value;
    }
}

function field(name) {
    var fullname = FIELDS_PREFIX + name;
    return function (evt) {
        return evt.Get(fullname);
    }
}

function STRCAT(evt, args) {
    var s = "";
    var i;
    for (i = 0; i < args.length; i++) {
        s += args[i];
    }
    return s;
}

/*
    call({dest: "nwparser.", fn: SYSVAL, args: [ field("$MSGID"),field("$ID1")]}),

    TODO:

    The above seems to indicate that in order to select MESSAGES from a header
    The value attribute "id1" must be used as key.
 */
function SYSVAL(evt, args) {
}

// TODO: Prune this from the tree.
function HDR(evt, args) {
}

// TODO: Implement?
function DIRCHK(evt, args) {
}

function DUR(evt, args) {
}

function URL(evt, args) {
}

function CALC(evt, args) {
    if (args.length !== 3) {
        console.warn("skipped call to CALC with " + args.length + " arguments.");
        return;
    }
    var a = parseInt(args[0]);
    var b = parseInt(args[2]);
    if (isNaN(a) || isNaN(b)) {
        console.warn("failed evaluating CALC arguments a='" + args[0] + "' b='" + args[2] + "'.");
        return;
    }
    var result;
    switch (args[1]) {
        case "+":
            result = a + b;
            break;
        case '-':
            result = a - b;
            break;
        case '*':
            result = a * b;
            break;
        default:
            // Only * and + seen in the parsers.
            console.warn("unknown CALC operation '" + args[1] + "'.");
            return;
    }
    // Always return a string
    return result !== undefined ? "" + result : result;
}

function RMQ(evt, args) {

}

// TODO: Replace with datetime call.
function UTC(evt, args) {

}

function call(opts) {
    var args = new Array(opts.args.length);
    return function (evt) {
        for (var i = 0; i < opts.args.length; i++) {
            args[i] = opts.args[i](evt);
        }
        var result = opts.fn(evt, args);
        if (result != null) {
            evt.Put(opts.dest, result);
        }
    }
}

function nop(evt) {
}

function lookup(opts) {
    return function (evt) {
        var key = opts.key(evt);
        if (key == null) return;
        var value = opts.map.keyvaluepairs[key];
        if (value === undefined) {
            value = opts.map.default;
        }
        if (value !== undefined) {
            evt.Put(opts.dest, value(evt));
        }
    }
}

function set(fields) {
    return new processor.AddFields({
        target: FIELDS_OBJECT,
        fields: fields,
    });
}

function setf(dst, src) {
    return function (evt) {
        var val = evt.Get(FIELDS_PREFIX + src);
        if (val != null) evt.Put(FIELDS_PREFIX + dst, val);
    }
}

function setc(dst, value) {
    return function (evt) {
        evt.Put(FIELDS_PREFIX + dst, value);
    }
}

function set_field(opts) {
    return function (evt) {
        var val = opts.value(evt);
        if (val != null) evt.Put(opts.dest, val);
    }
}

function dump(label) {
    return function (evt) {
        console.log("Dump of event at " + label + ": " + JSON.stringify(evt, null, '\t'))
    }
}

function date_time_join_args(evt, arglist) {
    var str = "";
    for (var i = 0; i < arglist.length; i++) {
        var fname = FIELDS_PREFIX + arglist[i];
        var val = evt.Get(fname);
        if (val != null) {
            if (str != "") str += " ";
            str += val;
        } else {
            if (debug) console.warn("in date_time: input arg " + fname + " is not set");
        }
    }
    return str;
}

function date_time_try_pattern(fmt, str, tzOffset) {
    var date = new Date();
    // Zero the date as much as possible.
    // date.setTime(0); <- not doing this to avoid dates defaulting to 1970.
    // Better to just clean the time part incl. milliseconds.
    date.setUTCHours(0, 0, 0, 0);
    // Using current year so logs default to this year.
    // Must use 1st Jan instead of current day to avoid problems when the
    // day of the month is defined before the month. For example:
    // Current date: 1 Nov
    // Logs: "31/Oct".
    // It will try to set day=31 to a date object with mon=Nov, which is not
    // valid.
    date.setUTCFullYear(date.getFullYear(), 0, 1);
    var pos = date_time_try_pattern_at_pos(fmt, str, 0, date);
    console.debug("XXX date XXX newdate=" + date.toUTCString());
    if (tzOffset !== undefined && tzOffset !== "") {
        var dateString = date.toISOString().replace("Z", tzOffset);
        var newdate = new Date(dateString);
        console.debug("XXX date XXX newdate=" + newdate + " (" + dateString + ")");
        if (!isNaN(newdate)) {
            date = newdate;
        } else {
            console.warn("Failed parsing date in given offset: " + dateString);
        }
    }
    return pos !== undefined? date : undefined;
}

function date_time_try_pattern_at_pos(fmt, str, pos, date) {
    var len = str.length;
    for (var proc = 0; pos !== undefined && pos < len && proc < fmt.length; proc++) {
        //console.warn("in date_time: enter proc["+proc+"] parsed='" + str.substr(0, pos) + "' unparsed='" +  str.substr(pos) + "' pos=" + pos + " date="+date);
        pos = fmt[proc](str, pos, date);
        //console.warn("in date_time: leave proc["+proc+"]='" + str + "' pos=" + pos + " date="+date);
    }
    return pos;
}

function date_time(opts) {
    return function (evt) {
        var tzOffset = tz_offset;
        if (tz_offset === 'event') {
            tzOffset = evt.Get("event.timezone");
        }
        var str = date_time_join_args(evt, opts.args);
        for (var i = 0; i < opts.fmts.length; i++) {
            var date = date_time_try_pattern(opts.fmts[i], str, tzOffset);
            if (date !== undefined) {
                evt.Put(FIELDS_PREFIX + opts.dest, date);
                if (debug) console.warn("in date_times: succeeded: " + evt.Get(FIELDS_PREFIX + opts.dest));
                return;
            }
        }
        if (debug) console.warn("in date_time: id=" + opts.id + " (s) FAILED: " + str);
    }
}

function duration(opts) {
    // TODO: Duration
    return nop;
}

function remove(fields) {
    return function (evt) {
        for (var i = 0; i < fields.length; i++) {
            evt.Delete(FIELDS_PREFIX + fields[i]);
        }
    }
}

function dc(ct) {
    var match = function (ct, str, pos) {
        var n = str.length;
        if (n - pos < ct.length) return;
        var part = str.substr(pos, ct.length);
        if (part !== ct) {
            return;
        }
        return pos + ct.length;
    }
    return function (str, pos, date) {
        var outPos = match(ct, str, pos);
        if (outPos === undefined) {
            // Try again, trimming leading space at str[pos:] and ct
            outPos = match(ct.substr(skipws(ct, 0)), str, skipws(str, pos));
        }
        return outPos;
    }
}


var shortMonths = {
    // mon => [ month_id , how many chars to skip if month in long form ]
    "Jan": [0, 4],
    "Feb": [1, 5],
    "Mar": [2, 2],
    "Apr": [3, 2],
    "May": [4, 0],
    "Jun": [5, 1],
    "Jul": [6, 1],
    "Aug": [7, 3],
    "Sep": [8, 6],
    "Oct": [9, 4],
    "Nov": [10, 5],
    "Dec": [11, 4],
    "jan": [0, 4],
    "feb": [1, 5],
    "mar": [2, 2],
    "apr": [3, 2],
    "may": [4, 0],
    "jun": [5, 1],
    "jul": [6, 1],
    "aug": [7, 3],
    "sep": [8, 6],
    "oct": [9, 4],
    "nov": [10, 5],
    "dec": [11, 4],
};

var monthSetter = {
    call: function (date, value) {
        date.setUTCMonth(value - 1);
    }
};

var unixSetter = {
    call: function (date, value) {
        date.setTime(value * 1000);
    }
}


// Make two-digit dates 00-69 interpreted as 2000-2069
// and dates 70-99 translated to 1970-1999.
// This is to support unix epoch.
var twoDigitYearEpoch = 70;
var twoDigitYearCentury = 2000;

var year2DigitSetter = {
    call: function(date, value) {
        date.setUTCFullYear(value < twoDigitYearEpoch? twoDigitYearCentury + value : twoDigitYearCentury + value - 100);
    }
}

// var dC = undefined;
var dR = dateMonthName(true);
var dB = dateMonthName(false);
var dM = dateFixedWidthNumber('M', 2, 1, 12, monthSetter);
var dG = dateVariableWidthNumber('G', 1, 12, monthSetter);
var dD = dateFixedWidthNumber('D', 2, 1, 31, Date.prototype.setUTCDate);
var dF = dateVariableWidthNumber('F', 1, 31, Date.prototype.setUTCDate);
var dH = dateFixedWidthNumber('H', 2, 0, 24, Date.prototype.setUTCHours);
var dI = dateVariableWidthNumber('I', 0, 24, Date.prototype.setUTCHours); // Accept hours >12
var dN = dateVariableWidthNumber('N', 0, 24, Date.prototype.setUTCHours);
var dT = dateFixedWidthNumber('T', 2, 0, 59, Date.prototype.setUTCMinutes);
var dU = dateVariableWidthNumber('U', 0, 59, Date.prototype.setUTCMinutes);
// TODO: var dJ = ...Julian day... Not used for datetimes but for durations.
var dP = parseAMPM; // AM|PM
var dQ = parseAMPM; // A.M.|P.M
var dS = dateFixedWidthNumber('S', 2, 0, 60, Date.prototype.setUTCSeconds);
var dO = dateVariableWidthNumber('O', 0, 60, Date.prototype.setUTCSeconds);
var dY = dateFixedWidthNumber('Y', 2, 0, 99, year2DigitSetter);
var dW = dateFixedWidthNumber('W', 4, 1000, 9999, Date.prototype.setUTCFullYear);
var dZ = parseHMS;
// TODO: var dA = ... This one is not used for datetimes but for durations.
var dX = dateVariableWidthNumber('X', 0, 0x10000000000, unixSetter);

// parseAMPM parses "A.M", "AM", "P.M", "PM" from logs.
// Only works if this modifier appears after the hour has been read from logs
// which is always the case in the 300 devices.
function parseAMPM(str, pos, date) {
    var n = str.length;
    var start = skipws(str, pos);
    if (start + 2 > n) return;
    var head = str.substr(start, 2).toUpperCase();
    var isPM = false;
    var skip = false;
    switch (head) {
        case "A.":
            skip = true;
        case "AM":
            break;
        case "P.":
            skip = true;
        case "PM":
            isPM = true;
            break;
        default:
            if (debug) console.warn("can't parse pos " + start + " as AM/PM: " + str + "(head:" + head + ")");
            return;
    }
    pos = start + 2;
    if (skip) {
        if (pos+2 > n || str.substr(pos, 2).toUpperCase() !== 'M.') {
            if (debug) console.warn("can't parse pos " + start + " as AM/PM: " + str + "(tail)");
            return;
        }
        pos += 2;
    }
    var hh = date.getUTCHours();
    if (isPM) {
        // Accept existing hour in 24h format.
        if (hh < 12) hh += 12;
    } else {
        if (hh === 12) hh = 0;
    }
    date.setUTCHours(hh);
    return pos;
}

function parseHMS(str, pos, date) {
    return date_time_try_pattern_at_pos([dN, dc(':'), dU, dc(':'), dO], str, pos, date);
}

function skipws(str, pos) {
    for (var n = str.length
        ; pos < n && str.charAt(pos) === ' '
        ; pos++)
        ;
    return pos;
}

function skipdigits(str, pos) {
    var c;
    for (var n = str.length
        ; pos < n && (c = str.charAt(pos)) >= '0' && c <= '9'
        ; pos++)
        ;
    return pos;
}

function dateVariableWidthNumber(fmtChar, min, max, setter) {
    return function (str, pos, date) {
        var start = skipws(str, pos);
        pos = skipdigits(str, start);
        var s = str.substr(start, pos - start);
        var value = parseInt(s, 10);
        if (value >= min && value <= max) {
            setter.call(date, value);
            return pos;
        }
        return;
    }
}

function dateFixedWidthNumber(fmtChar, width, min, max, setter) {
    return function (str, pos, date) {
        pos = skipws(str, pos);
        var n = str.length;
        if (pos + width > n) return;
        var s = str.substr(pos, width);
        var value = parseInt(s, 10);
        if (value >= min && value <= max) {
            setter.call(date, value);
            return pos + width;
        }
        //console.warn("parsing date_time: '" + s + "' is not valid for %" + fmtChar);
        return;
    }
}

// Short month name (Jan..Dec).
function dateMonthName(long) {
    return function (str, pos, date) {
        pos = skipws(str, pos);
        var n = str.length;
        if (pos + 3 > n) return;
        var mon = str.substr(pos, 3);
        var idx = shortMonths[mon];
        if (idx === undefined) {
            idx = shortMonths[mon.toLowerCase()];
        }
        if (idx === undefined) {
            //console.warn("parsing date_time: '" + mon + "' is not a valid short month (%B)");
            return;
        }
        date.setUTCMonth(idx[0]);
        return pos + 3 + (long ? idx[1] : 0);
    }
}

function domain(dst, src) {
    return nop;
}

function ext(dst, src) {
    return nop;
}

function fqdn(dst, src) {
    return nop;
}

function page(dst, src) {
    return nop;
}

function path(dst, src) {
    return nop;
}

function port(dst, src) {
    return nop;
}

function query(dst, src) {
    return nop;
}

function root(dst, src) {
    return nop;
}

var uR = nop;
var uB = nop;
var uM = nop;
var uG = nop;
var uD = nop;
var uF = nop;
var uH = nop;
var uI = nop;
var uN = nop;
var uT = nop;
var uU = nop;
var uJ = nop;
var uP = nop;
var uQ = nop;
var uS = nop;
var uO = nop;
var uY = nop;
var uW = nop;
var uZ = nop;
var uA = nop;
var uX = nop;

var ecs_mappings = {
    'msg': {to:[{field: 'log.original', setter: fld_set}]},
    'messageid': {to:[{field: 'event.code', setter: fld_prio, prio: 1}]},
    'event_time': {convert: to_date, to:[{field: '@timestamp', setter: fld_set}]},
    'username': {to:[{field: 'user.name', setter: fld_append}]},
    'event_description': {to:[{field: 'message', setter: fld_prio, prio: 0}]},
    'action': {to:[{field: 'event.action', setter: fld_set}]},
    'saddr': {convert: to_ip, to:[{field: 'source.ip', setter: fld_append},{field: 'related.ip', setter: fld_append}]},
    'hostname': {to:[{field: 'host.name', setter: fld_prio, prio: 0}]},
    'severity': {to:[{field: 'log.level', setter: fld_set}]},
    'ec_outcome': {to:[{field: 'event.outcome', setter: fld_set}]},
    'daddr': {convert: to_ip, to:[{field: 'destination.ip', setter: fld_append},{field: 'related.ip', setter: fld_append}]},
    'event_type': {to:[{field: 'event.category', setter: fld_set}]},
    'id': {to:[{field: 'event.code', setter: fld_prio, prio: 0}]},
    'protocol': {to:[{field: 'network.protocol', setter: fld_set}]},
    'version': {to:[{field: 'observer.version', setter: fld_set}]},
    'filename': {to:[{field: 'file.name', setter: fld_set}]},
    'hostip': {convert: to_ip, to:[{field: 'host.ip', setter: fld_prio, prio: 0},{field: 'related.ip', setter: fld_append}]},
    'sport': {convert: to_long, to:[{field: 'source.port', setter: fld_prio, prio: 0}]},
    'dport': {convert: to_long, to:[{field: 'destination.port', setter: fld_prio, prio: 0}]},
    'shost': {to:[{field: 'host.hostname', setter: fld_set},{field: 'source.address', setter: fld_set}]},
    'url': {to:[{field: 'url.original', setter: fld_prio, prio: 1}]},
    'application': {to:[{field: 'network.application', setter: fld_set}]},
    'service': {to:[{field: 'service.name', setter: fld_prio, prio: 1}]},
    'domain': {to:[{field: 'server.domain', setter: fld_prio, prio: 0}]},
    'dhost': {to:[{field: 'destination.address', setter: fld_set}]},
    'c_username': {to:[{field: 'user.name', setter: fld_append}]},
    'process_id': {convert: to_long, to:[{field: 'process.pid', setter: fld_prio, prio: 0}]},
    'process': {to:[{field: 'process.name', setter: fld_prio, prio: 0}]},
    'rulename': {to:[{field: 'rule.name', setter: fld_set}]},
    'product': {to:[{field: 'observer.product', setter: fld_set}]},
    'directory': {to:[{field: 'file.directory', setter: fld_set}]},
    'interface': {to:[{field: 'network.interface.name', setter: fld_set}]},
    'bytes': {convert: to_long, to:[{field: 'network.bytes', setter: fld_set}]},
    'smacaddr': {convert: to_mac, to:[{field: 'source.mac', setter: fld_set}]},
    'sbytes': {convert: to_long, to:[{field: 'source.bytes', setter: fld_set}]},
    'rbytes': {convert: to_long, to:[{field: 'destination.bytes', setter: fld_set}]},
    'uid': {to:[{field: 'user.name', setter: fld_append}]},
    'sinterface': {to:[{field: 'observer.ingress.interface.name', setter: fld_set}]},
    'user_agent': {to:[{field: 'user_agent.original', setter: fld_set}]},
    'timezone': {to:[{field: 'event.timezone', setter: fld_set}]},
    'dmacaddr': {convert: to_mac, to:[{field: 'destination.mac', setter: fld_set}]},
    'direction': {to:[{field: 'network.direction', setter: fld_set}]},
    'stransaddr': {convert: to_ip, to:[{field: 'source.nat.ip', setter: fld_prio, prio: 0},{field: 'related.ip', setter: fld_append}]},
    'administrator': {to:[{field: 'user.name', setter: fld_append}]},
    'dinterface': {to:[{field: 'observer.egress.interface.name', setter: fld_set}]},
    'webpage': {to:[{field: 'http.response.body.content', setter: fld_set}]},
    'web_query': {to:[{field: 'url.query', setter: fld_prio, prio: 1}]},
    'web_referer': {to:[{field: 'http.request.referrer', setter: fld_prio, prio: 0}]},
    'dtransaddr': {convert: to_ip, to:[{field: 'destination.nat.ip', setter: fld_prio, prio: 0},{field: 'related.ip', setter: fld_append}]},
    'location_desc': {to:[{field: 'geo.name', setter: fld_set}]},
    'filename_size': {convert: to_long, to:[{field: 'file.size', setter: fld_set}]},
    'stransport': {convert: to_long, to:[{field: 'source.nat.port', setter: fld_prio, prio: 0}]},
    'dtransport': {convert: to_long, to:[{field: 'destination.nat.port', setter: fld_prio, prio: 0}]},
    'web_domain': {to:[{field: 'url.domain', setter: fld_prio, prio: 1}]},
    'packets': {convert: to_long, to:[{field: 'network.packets', setter: fld_set}]},
    'parent_pid': {convert: to_long, to:[{field: 'process.ppid', setter: fld_prio, prio: 0}]},
    'logon_id': {to:[{field: 'user.name', setter: fld_append}]},
    'user_fullname': {to:[{field: 'user.full_name', setter: fld_prio, prio: 0}]},
    'owner': {to:[{field: 'user.name', setter: fld_append}]},
    'web_root': {to:[{field: 'url.path', setter: fld_set}]},
    'ddomain': {to:[{field: 'destination.domain', setter: fld_prio, prio: 0}]},
    'filetype': {to:[{field: 'file.type', setter: fld_set}]},
    'sdomain': {to:[{field: 'source.domain', setter: fld_prio, prio: 0}]},
    'c_domain': {to:[{field: 'source.domain', setter: fld_prio, prio: 1}]},
    'host': {to:[{field: 'host.name', setter: fld_prio, prio: 1}]},
    'child_pid': {convert: to_long, to:[{field: 'process.pid', setter: fld_prio, prio: 1}]},
    'location_src': {to:[{field: 'source.geo.country_name', setter: fld_set}]},
    'saddr_v6': {convert: to_ip, to:[{field: 'source.ip', setter: fld_append},{field: 'related.ip', setter: fld_append}]},
    'process_src': {to:[{field: 'process.parent.name', setter: fld_prio, prio: 1}]},
    'location_dst': {to:[{field: 'destination.geo.country_name', setter: fld_set}]},
    'location_country': {to:[{field: 'geo.country_name', setter: fld_set}]},
    'service_account': {to:[{field: 'user.name', setter: fld_append}]},
    'domain_id': {to:[{field: 'user.domain', setter: fld_set}]},
    'process_id_src': {convert: to_long, to:[{field: 'process.ppid', setter: fld_prio, prio: 1}]},
    'dns_querytype': {to:[{field: 'dns.question.type', setter: fld_set}]},
    'daddr_v6': {convert: to_ip, to:[{field: 'destination.ip', setter: fld_append},{field: 'related.ip', setter: fld_append}]},
    'method': {to:[{field: 'http.request.method', setter: fld_set}]},
    'ip.orig': {convert: to_ip, to:[{field: 'network.forwarded_ip', setter: fld_prio, prio: 0},{field: 'related.ip', setter: fld_append}]},
    'location_city': {to:[{field: 'geo.city_name', setter: fld_set}]},
    'c_user_name': {to:[{field: 'user.name', setter: fld_append}]},
    'child_process': {to:[{field: 'process.name', setter: fld_prio, prio: 1}]},
    'parent_process': {to:[{field: 'process.parent.name', setter: fld_prio, prio: 0}]},
    'urldomain': {to:[{field: 'url.domain', setter: fld_prio, prio: 0}]},
    'web_extension': {to:[{field: 'file.extension', setter: fld_prio, prio: 0}]},
    'hostip_v6': {convert: to_ip, to:[{field: 'host.ip', setter: fld_prio, prio: 1},{field: 'related.ip', setter: fld_append}]},
    'location_state': {to:[{field: 'geo.region_name', setter: fld_set}]},
    'referer': {to:[{field: 'http.request.referrer', setter: fld_prio, prio: 1}]},
    'user': {to:[{field: 'user.name', setter: fld_append}]},
    'filepath': {to:[{field: 'file.path', setter: fld_set}]},
    'urlquery': {to:[{field: 'url.query', setter: fld_prio, prio: 0}]},
    'user_id': {to:[{field: 'user.id', setter: fld_prio, prio: 0}]},
    'dns.resptext': {to:[{field: 'dns.answers.name', setter: fld_set}]},
    'domainname': {to:[{field: 'server.domain', setter: fld_prio, prio: 1}]},
    'extension': {to:[{field: 'file.extension', setter: fld_prio, prio: 1}]},
    'patient_fullname': {to:[{field: 'user.full_name', setter: fld_prio, prio: 1}]},
    'latdec_dst': {convert: to_double, to:[{field: 'destination.geo.location.lat', setter: fld_set}]},
    'latdec_src': {convert: to_double, to:[{field: 'source.geo.location.lat', setter: fld_set}]},
    'longdec_src': {convert: to_double, to:[{field: 'source.geo.location.lon', setter: fld_set}]},
    'orig_ip': {convert: to_ip, to:[{field: 'network.forwarded_ip', setter: fld_prio, prio: 1},{field: 'related.ip', setter: fld_append}]},
    'service.name': {to:[{field: 'service.name', setter: fld_prio, prio: 0}]},
    'url_raw': {to:[{field: 'url.original', setter: fld_prio, prio: 0}]},
    'user.id': {to:[{field: 'user.id', setter: fld_prio, prio: 1}]},
    'c_logon_id': {to:[{field: 'user.id', setter: fld_prio, prio: 2}]},
    'devicehostip': {convert: to_ip, to:[{field: 'host.ip', setter: fld_prio, prio: 2},{field: 'related.ip', setter: fld_append}]},
    'alias.ip': {convert: to_ip, to:[{field: 'host.ip', setter: fld_prio, prio: 3},{field: 'related.ip', setter: fld_append}]},
    'alias.ipv6': {convert: to_ip, to:[{field: 'host.ip', setter: fld_prio, prio: 4},{field: 'related.ip', setter: fld_append}]},
    'devicehostmac': {convert: to_mac, to:[{field: 'host.mac', setter: fld_prio, prio: 0}]},
    'alias.mac': {convert: to_mac, to:[{field: 'host.mac', setter: fld_prio, prio: 1}]},
    'cctld': {to:[{field: 'url.top_level_domain', setter: fld_prio, prio: 1}]},
    'child_pid_val': {to:[{field: 'process.title', setter: fld_set}]},
    'city.dst': {to:[{field: 'destination.geo.city_name', setter: fld_set}]},
    'city.src': {to:[{field: 'source.geo.city_name', setter: fld_set}]},
    'dns.responsetype': {to:[{field: 'dns.answers.type', setter: fld_set}]},
    'domain.dst': {to:[{field: 'destination.domain', setter: fld_prio, prio: 1}]},
    'domain.src': {to:[{field: 'source.domain', setter: fld_prio, prio: 2}]},
    'file.attributes': {to:[{field: 'file.attributes', setter: fld_set}]},
    'ip.trans.dst': {convert: to_ip, to:[{field: 'destination.nat.ip', setter: fld_prio, prio: 1},{field: 'related.ip', setter: fld_append}]},
    'ip.trans.src': {convert: to_ip, to:[{field: 'source.nat.ip', setter: fld_prio, prio: 1},{field: 'related.ip', setter: fld_append}]},
    'ipv6.orig': {convert: to_ip, to:[{field: 'network.forwarded_ip', setter: fld_prio, prio: 2},{field: 'related.ip', setter: fld_append}]},
    'longdec_dst': {convert: to_double, to:[{field: 'destination.geo.location.lon', setter: fld_set}]},
    'parent_pid_val': {to:[{field: 'process.parent.title', setter: fld_set}]},
    'port.dst': {convert: to_long, to:[{field: 'destination.port', setter: fld_prio, prio: 1}]},
    'port.src': {convert: to_long, to:[{field: 'source.port', setter: fld_prio, prio: 1}]},
    'port.trans.dst': {convert: to_long, to:[{field: 'destination.nat.port', setter: fld_prio, prio: 1}]},
    'port.trans.src': {convert: to_long, to:[{field: 'source.nat.port', setter: fld_prio, prio: 1}]},
    'query': {to:[{field: 'url.query', setter: fld_prio, prio: 2}]},
    'sld': {to:[{field: 'url.registered_domain', setter: fld_set}]},
    'tcp.dstport': {convert: to_long, to:[{field: 'destination.port', setter: fld_prio, prio: 2}]},
    'tcp.srcport': {convert: to_long, to:[{field: 'source.port', setter: fld_prio, prio: 2}]},
    'tld': {to:[{field: 'url.top_level_domain', setter: fld_prio, prio: 0}]},
    'udp.dstport': {convert: to_long, to:[{field: 'destination.port', setter: fld_prio, prio: 3}]},
    'udp.srcport': {convert: to_long, to:[{field: 'source.port', setter: fld_prio, prio: 3}]},
}

var rsa_mappings = {
    'msg': {to:[{field: 'rsa.internal.msg', setter: fld_set}]},
    'messageid': {to:[{field: 'rsa.internal.messageid', setter: fld_set}]},
    'event_time': {convert: to_date, to:[{field: 'rsa.time.event_time', setter: fld_set}]},
    'event_description': {to:[{field: 'rsa.internal.event_desc', setter: fld_set}]},
    'action': {to:[{field: 'rsa.misc.action', setter: fld_append}]},
    'info': {to:[{field: 'rsa.db.index', setter: fld_set}]},
    'payload': {convert: to_long, to:[{field: 'rsa.internal.payload', setter: fld_set}]},
    'message': {to:[{field: 'rsa.internal.message', setter: fld_set}]},
    'hostname': {to:[{field: 'rsa.network.alias_host', setter: fld_append}]},
    'ec_activity': {to:[{field: 'rsa.investigations.ec_activity', setter: fld_set}]},
    'ec_theme': {to:[{field: 'rsa.investigations.ec_theme', setter: fld_set}]},
    'ec_subject': {to:[{field: 'rsa.investigations.ec_subject', setter: fld_set}]},
    'result': {to:[{field: 'rsa.misc.result', setter: fld_set}]},
    'severity': {to:[{field: 'rsa.misc.severity', setter: fld_set}]},
    'ec_outcome': {to:[{field: 'rsa.investigations.ec_outcome', setter: fld_set}]},
    'event_type': {to:[{field: 'rsa.misc.event_type', setter: fld_set}]},
    'id': {to:[{field: 'rsa.misc.reference_id', setter: fld_set}]},
    'version': {to:[{field: 'rsa.misc.version', setter: fld_set}]},
    'disposition': {to:[{field: 'rsa.misc.disposition', setter: fld_set}]},
    'resultcode': {to:[{field: 'rsa.misc.result_code', setter: fld_prio, prio: 0}]},
    'category': {to:[{field: 'rsa.misc.category', setter: fld_set}]},
    'obj_name': {to:[{field: 'rsa.misc.obj_name', setter: fld_set}]},
    'obj_type': {to:[{field: 'rsa.misc.obj_type', setter: fld_set}]},
    'event_source': {to:[{field: 'rsa.misc.event_source', setter: fld_set}]},
    'domain': {to:[{field: 'rsa.network.domain', setter: fld_set}]},
    'sessionid': {to:[{field: 'rsa.misc.log_session_id', setter: fld_set}]},
    'group': {to:[{field: 'rsa.misc.group', setter: fld_set}]},
    'dhost': {to:[{field: 'rsa.network.host_dst', setter: fld_set}]},
    'dclass_counter1': {convert: to_long, to:[{field: 'rsa.counters.dclass_c1', setter: fld_set}]},
    'policyname': {to:[{field: 'rsa.misc.policy_name', setter: fld_prio, prio: 0}]},
    'rulename': {to:[{field: 'rsa.misc.rule_name', setter: fld_set}]},
    'context': {to:[{field: 'rsa.misc.context', setter: fld_set}]},
    'change_new': {to:[{field: 'rsa.misc.change_new', setter: fld_set}]},
    'space': {to:[{field: 'rsa.misc.space', setter: fld_set}]},
    'agent': {to:[{field: 'rsa.misc.client', setter: fld_prio, prio: 0}]},
    'duration': {convert: to_double, to:[{field: 'rsa.time.duration_time', setter: fld_set}]},
    'msgIdPart1': {to:[{field: 'rsa.misc.msgIdPart1', setter: fld_set}]},
    'network_service': {to:[{field: 'rsa.network.network_service', setter: fld_set}]},
    'interface': {to:[{field: 'rsa.network.interface', setter: fld_set}]},
    'msgIdPart2': {to:[{field: 'rsa.misc.msgIdPart2', setter: fld_set}]},
    'change_old': {to:[{field: 'rsa.misc.change_old', setter: fld_set}]},
    'event_time_string': {to:[{field: 'rsa.time.event_time_str', setter: fld_prio, prio: 0}]},
    'time': {convert: to_date, to:[{field: 'rsa.internal.time', setter: fld_set}]},
    'operation_id': {to:[{field: 'rsa.misc.operation_id', setter: fld_set}]},
    'event_state': {to:[{field: 'rsa.misc.event_state', setter: fld_set}]},
    'network_port': {convert: to_long, to:[{field: 'rsa.network.network_port', setter: fld_set}]},
    'starttime': {convert: to_date, to:[{field: 'rsa.time.starttime', setter: fld_set}]},
    'web_method': {to:[{field: 'rsa.misc.action', setter: fld_append}]},
    'month': {to:[{field: 'rsa.time.month', setter: fld_set}]},
    'authmethod': {to:[{field: 'rsa.identity.auth_method', setter: fld_set}]},
    'day': {to:[{field: 'rsa.time.day', setter: fld_set}]},
    'level': {convert: to_long, to:[{field: 'rsa.internal.level', setter: fld_set}]},
    'group_object': {to:[{field: 'rsa.misc.group_object', setter: fld_set}]},
    'node': {to:[{field: 'rsa.misc.node', setter: fld_set}]},
    'rule': {to:[{field: 'rsa.misc.rule', setter: fld_set}]},
    'macaddr': {convert: to_mac, to:[{field: 'rsa.network.eth_host', setter: fld_set}]},
    'sinterface': {to:[{field: 'rsa.network.sinterface', setter: fld_set}]},
    'device': {to:[{field: 'rsa.misc.device_name', setter: fld_set}]},
    'endtime': {convert: to_date, to:[{field: 'rsa.time.endtime', setter: fld_set}]},
    'msg_id': {to:[{field: 'rsa.internal.msg_id', setter: fld_set}]},
    'timezone': {to:[{field: 'rsa.time.timezone', setter: fld_set}]},
    'param': {to:[{field: 'rsa.misc.param', setter: fld_set}]},
    'to': {to:[{field: 'rsa.email.email_dst', setter: fld_set}]},
    'change_attribute': {to:[{field: 'rsa.misc.change_attrib', setter: fld_set}]},
    'event_cat': {convert: to_long, to:[{field: 'rsa.investigations.event_cat', setter: fld_prio, prio: 0}]},
    'event_cat_name': {to:[{field: 'rsa.investigations.event_cat_name', setter: fld_prio, prio: 0}]},
    'event_computer': {to:[{field: 'rsa.misc.event_computer', setter: fld_set}]},
    'from': {to:[{field: 'rsa.email.email_src', setter: fld_set}]},
    'id1': {to:[{field: 'rsa.misc.reference_id1', setter: fld_set}]},
    'vid': {to:[{field: 'rsa.internal.msg_vid', setter: fld_set}]},
    'privilege': {to:[{field: 'rsa.file.privilege', setter: fld_set}]},
    'user_role': {to:[{field: 'rsa.identity.user_role', setter: fld_set}]},
    'event_log': {to:[{field: 'rsa.misc.event_log', setter: fld_set}]},
    'fqdn': {to:[{field: 'rsa.web.fqdn', setter: fld_set}]},
    'hostid': {to:[{field: 'rsa.network.alias_host', setter: fld_append}]},
    'data': {to:[{field: 'rsa.internal.data', setter: fld_set}]},
    'dclass_counter2': {convert: to_long, to:[{field: 'rsa.counters.dclass_c2', setter: fld_set}]},
    'dinterface': {to:[{field: 'rsa.network.dinterface', setter: fld_set}]},
    'os': {to:[{field: 'rsa.misc.OS', setter: fld_set}]},
    'terminal': {to:[{field: 'rsa.misc.terminal', setter: fld_set}]},
    'msgIdPart3': {to:[{field: 'rsa.misc.msgIdPart3', setter: fld_set}]},
    'filter': {to:[{field: 'rsa.misc.filter', setter: fld_set}]},
    'serial_number': {to:[{field: 'rsa.misc.serial_number', setter: fld_set}]},
    'subject': {to:[{field: 'rsa.email.subject', setter: fld_set}]},
    'dn': {to:[{field: 'rsa.identity.dn', setter: fld_set}]},
    'duration_string': {to:[{field: 'rsa.time.duration_str', setter: fld_set}]},
    'instance': {to:[{field: 'rsa.db.instance', setter: fld_set}]},
    'signame': {to:[{field: 'rsa.misc.policy_name', setter: fld_prio, prio: 1}]},
    'date': {to:[{field: 'rsa.time.date', setter: fld_set}]},
    'logon_type': {to:[{field: 'rsa.identity.logon_type', setter: fld_set}]},
    'threat_name': {to:[{field: 'rsa.threat.threat_category', setter: fld_set}]},
    'vlan': {convert: to_long, to:[{field: 'rsa.network.vlan', setter: fld_set}]},
    'checksum': {to:[{field: 'rsa.misc.checksum', setter: fld_set}]},
    'event_user': {to:[{field: 'rsa.misc.event_user', setter: fld_set}]},
    'year': {to:[{field: 'rsa.time.year', setter: fld_set}]},
    'virusname': {to:[{field: 'rsa.misc.virusname', setter: fld_set}]},
    'user_address': {to:[{field: 'rsa.email.email', setter: fld_append}]},
    'content_type': {to:[{field: 'rsa.misc.content_type', setter: fld_set}]},
    'db_name': {to:[{field: 'rsa.db.database', setter: fld_set}]},
    'groupid': {to:[{field: 'rsa.misc.group_id', setter: fld_set}]},
    'policy_id': {to:[{field: 'rsa.misc.policy_id', setter: fld_set}]},
    'encryption_type': {to:[{field: 'rsa.crypto.crypto', setter: fld_set}]},
    'recorded_time': {convert: to_date, to:[{field: 'rsa.time.recorded_time', setter: fld_set}]},
    'vsys': {to:[{field: 'rsa.misc.vsys', setter: fld_set}]},
    'connectionid': {to:[{field: 'rsa.misc.connection_id', setter: fld_prio, prio: 0}]},
    'vendor_event_cat': {to:[{field: 'rsa.investigations.event_vcat', setter: fld_set}]},
    'profile': {to:[{field: 'rsa.identity.profile', setter: fld_set}]},
    'id2': {to:[{field: 'rsa.misc.reference_id2', setter: fld_set}]},
    'sensor': {to:[{field: 'rsa.misc.sensor', setter: fld_set}]},
    'sigid': {convert: to_long, to:[{field: 'rsa.misc.sig_id', setter: fld_set}]},
    'datetime': {to:[{field: 'rsa.time.datetime', setter: fld_set}]},
    'src_zone': {to:[{field: 'rsa.network.zone_src', setter: fld_set}]},
    'portname': {to:[{field: 'rsa.misc.port_name', setter: fld_set}]},
    'rule_group': {to:[{field: 'rsa.misc.rule_group', setter: fld_set}]},
    'ssid': {to:[{field: 'rsa.wireless.wlan_ssid', setter: fld_prio, prio: 0}]},
    'zone': {to:[{field: 'rsa.network.zone', setter: fld_set}]},
    'dst_zone': {to:[{field: 'rsa.network.zone_dst', setter: fld_set}]},
    'accesses': {to:[{field: 'rsa.identity.accesses', setter: fld_set}]},
    'gateway': {to:[{field: 'rsa.network.gateway', setter: fld_set}]},
    'risk_num': {convert: to_double, to:[{field: 'rsa.misc.risk_num', setter: fld_set}]},
    'trigger_val': {to:[{field: 'rsa.misc.trigger_val', setter: fld_set}]},
    's_cipher': {to:[{field: 'rsa.crypto.cipher_src', setter: fld_set}]},
    'icmptype': {convert: to_long, to:[{field: 'rsa.network.icmp_type', setter: fld_set}]},
    'sessionid1': {to:[{field: 'rsa.misc.log_session_id1', setter: fld_set}]},
    'obj_server': {to:[{field: 'rsa.internal.obj_server', setter: fld_set}]},
    'threat_val': {to:[{field: 'rsa.threat.threat_desc', setter: fld_set}]},
    'web_cookie': {to:[{field: 'rsa.web.web_cookie', setter: fld_set}]},
    'web_host': {to:[{field: 'rsa.web.alias_host', setter: fld_set}]},
    'component_version': {to:[{field: 'rsa.misc.comp_version', setter: fld_set}]},
    'content_version': {to:[{field: 'rsa.misc.content_version', setter: fld_set}]},
    'event_counter': {convert: to_long, to:[{field: 'rsa.counters.event_counter', setter: fld_set}]},
    'hardware_id': {to:[{field: 'rsa.misc.hardware_id', setter: fld_set}]},
    'mask': {to:[{field: 'rsa.network.mask', setter: fld_set}]},
    'risk': {to:[{field: 'rsa.misc.risk', setter: fld_set}]},
    'event_id': {to:[{field: 'rsa.misc.event_id', setter: fld_set}]},
    'reason': {to:[{field: 'rsa.misc.reason', setter: fld_set}]},
    'status': {to:[{field: 'rsa.misc.status', setter: fld_set}]},
    'dclass_ratio1': {to:[{field: 'rsa.counters.dclass_r1', setter: fld_set}]},
    'icmpcode': {convert: to_long, to:[{field: 'rsa.network.icmp_code', setter: fld_set}]},
    'mail_id': {to:[{field: 'rsa.misc.mail_id', setter: fld_set}]},
    'realm': {to:[{field: 'rsa.identity.realm', setter: fld_set}]},
    'sid': {to:[{field: 'rsa.identity.user_sid_dst', setter: fld_set}]},
    'cert_subject': {to:[{field: 'rsa.crypto.cert_subject', setter: fld_set}]},
    'dclass_counter3': {convert: to_long, to:[{field: 'rsa.counters.dclass_c3', setter: fld_set}]},
    'disk_volume': {to:[{field: 'rsa.storage.disk_volume', setter: fld_set}]},
    'reputation_num': {convert: to_double, to:[{field: 'rsa.web.reputation_num', setter: fld_set}]},
    'access_point': {to:[{field: 'rsa.wireless.access_point', setter: fld_set}]},
    'dclass_counter1_string': {to:[{field: 'rsa.counters.dclass_c1_str', setter: fld_set}]},
    'src_dn': {to:[{field: 'rsa.identity.dn_src', setter: fld_set}]},
    'peer': {to:[{field: 'rsa.crypto.peer', setter: fld_set}]},
    'protocol_detail': {to:[{field: 'rsa.network.protocol_detail', setter: fld_set}]},
    'rule_uid': {to:[{field: 'rsa.misc.rule_uid', setter: fld_set}]},
    'trigger_desc': {to:[{field: 'rsa.misc.trigger_desc', setter: fld_set}]},
    'inout': {to:[{field: 'rsa.misc.inout', setter: fld_set}]},
    'p_msgid': {to:[{field: 'rsa.misc.p_msgid', setter: fld_set}]},
    'dmask': {to:[{field: 'rsa.network.dmask', setter: fld_set}]},
    'effective_time': {convert: to_date, to:[{field: 'rsa.time.effective_time', setter: fld_set}]},
    'port': {convert: to_long, to:[{field: 'rsa.network.port', setter: fld_set}]},
    'smask': {to:[{field: 'rsa.network.smask', setter: fld_set}]},
    'trans_id': {to:[{field: 'rsa.db.transact_id', setter: fld_set}]},
    'web_ref_domain': {to:[{field: 'rsa.web.web_ref_domain', setter: fld_set}]},
    'data_type': {to:[{field: 'rsa.misc.data_type', setter: fld_set}]},
    'msgIdPart4': {to:[{field: 'rsa.misc.msgIdPart4', setter: fld_set}]},
    's_ciphersize': {convert: to_long, to:[{field: 'rsa.crypto.cipher_size_src', setter: fld_set}]},
    'error': {to:[{field: 'rsa.misc.error', setter: fld_set}]},
    'expiration_time': {convert: to_date, to:[{field: 'rsa.time.expire_time', setter: fld_set}]},
    'ike': {to:[{field: 'rsa.crypto.ike', setter: fld_set}]},
    'index': {to:[{field: 'rsa.misc.index', setter: fld_set}]},
    'listnum': {to:[{field: 'rsa.misc.listnum', setter: fld_set}]},
    'lun': {to:[{field: 'rsa.storage.lun', setter: fld_set}]},
    'obj_value': {to:[{field: 'rsa.internal.obj_val', setter: fld_set}]},
    'user_org': {to:[{field: 'rsa.identity.org', setter: fld_set}]},
    'resource': {to:[{field: 'rsa.internal.resource', setter: fld_set}]},
    'scheme': {to:[{field: 'rsa.crypto.scheme', setter: fld_set}]},
    'ntype': {to:[{field: 'rsa.misc.ntype', setter: fld_set}]},
    'dst_dn': {to:[{field: 'rsa.identity.dn_dst', setter: fld_set}]},
    'user_fname': {to:[{field: 'rsa.identity.firstname', setter: fld_set}]},
    'user_lname': {to:[{field: 'rsa.identity.lastname', setter: fld_set}]},
    'observed_val': {to:[{field: 'rsa.misc.observed_val', setter: fld_set}]},
    'policy_value': {to:[{field: 'rsa.misc.policy_value', setter: fld_set}]},
    'pool_name': {to:[{field: 'rsa.misc.pool_name', setter: fld_set}]},
    'rule_template': {to:[{field: 'rsa.misc.rule_template', setter: fld_set}]},
    'count': {to:[{field: 'rsa.misc.count', setter: fld_set}]},
    'number': {to:[{field: 'rsa.misc.number', setter: fld_set}]},
    'sigcat': {to:[{field: 'rsa.misc.sigcat', setter: fld_set}]},
    'type': {to:[{field: 'rsa.misc.type', setter: fld_set}]},
    'r_hostid': {to:[{field: 'rsa.network.alias_host', setter: fld_append}]},
    'comments': {to:[{field: 'rsa.misc.comments', setter: fld_set}]},
    'doc_number': {convert: to_long, to:[{field: 'rsa.misc.doc_number', setter: fld_set}]},
    'cc': {to:[{field: 'rsa.email.email', setter: fld_append}]},
    'expected_val': {to:[{field: 'rsa.misc.expected_val', setter: fld_set}]},
    'jobnum': {to:[{field: 'rsa.misc.job_num', setter: fld_set}]},
    'obj_id': {to:[{field: 'rsa.internal.obj_id', setter: fld_set}]},
    'peer_id': {to:[{field: 'rsa.crypto.peer_id', setter: fld_set}]},
    'permissions': {to:[{field: 'rsa.db.permissions', setter: fld_set}]},
    'processing_time': {to:[{field: 'rsa.time.process_time', setter: fld_set}]},
    'sigtype': {to:[{field: 'rsa.crypto.sig_type', setter: fld_set}]},
    'dst_spi': {to:[{field: 'rsa.misc.spi_dst', setter: fld_set}]},
    'src_spi': {to:[{field: 'rsa.misc.spi_src', setter: fld_set}]},
    'statement': {to:[{field: 'rsa.internal.statement', setter: fld_set}]},
    'user_dept': {to:[{field: 'rsa.identity.user_dept', setter: fld_set}]},
    'c_sid': {to:[{field: 'rsa.identity.user_sid_src', setter: fld_set}]},
    'web_ref_query': {to:[{field: 'rsa.web.web_ref_query', setter: fld_set}]},
    'wifi_channel': {convert: to_long, to:[{field: 'rsa.wireless.wlan_channel', setter: fld_set}]},
    'bssid': {to:[{field: 'rsa.wireless.wlan_ssid', setter: fld_prio, prio: 1}]},
    'cert_issuer': {to:[{field: 'rsa.crypto.cert_issuer', setter: fld_set}]},
    'code': {to:[{field: 'rsa.misc.code', setter: fld_set}]},
    'remote_domain': {to:[{field: 'rsa.web.remote_domain', setter: fld_set}]},
    'agent.id': {to:[{field: 'rsa.misc.agent_id', setter: fld_set}]},
    'cert_hostname': {to:[{field: 'rsa.crypto.cert_host_name', setter: fld_set}]},
    'message_body': {to:[{field: 'rsa.misc.message_body', setter: fld_set}]},
    'calling_to': {to:[{field: 'rsa.misc.phone', setter: fld_prio, prio: 0}]},
    'sigid_string': {to:[{field: 'rsa.misc.sig_id_str', setter: fld_set}]},
    'tbl_name': {to:[{field: 'rsa.db.table_name', setter: fld_set}]},
    'cmd': {to:[{field: 'rsa.misc.cmd', setter: fld_set}]},
    'misc': {to:[{field: 'rsa.misc.misc', setter: fld_set}]},
    'name': {to:[{field: 'rsa.misc.name', setter: fld_set}]},
    'web_ref_host': {to:[{field: 'rsa.network.alias_host', setter: fld_append}]},
    'audit_class': {to:[{field: 'rsa.internal.audit_class', setter: fld_set}]},
    'cert_error': {to:[{field: 'rsa.crypto.cert_error', setter: fld_set}]},
    'd_cipher': {to:[{field: 'rsa.crypto.cipher_dst', setter: fld_set}]},
    'd_ciphersize': {convert: to_long, to:[{field: 'rsa.crypto.cipher_size_dst', setter: fld_set}]},
    'cpu': {convert: to_long, to:[{field: 'rsa.misc.cpu', setter: fld_set}]},
    'db_id': {to:[{field: 'rsa.db.db_id', setter: fld_set}]},
    'db_pid': {convert: to_long, to:[{field: 'rsa.db.db_pid', setter: fld_set}]},
    'entry': {to:[{field: 'rsa.internal.entry', setter: fld_set}]},
    'detail': {to:[{field: 'rsa.misc.event_desc', setter: fld_set}]},
    'federated_sp': {to:[{field: 'rsa.identity.federated_sp', setter: fld_set}]},
    'netname': {to:[{field: 'rsa.network.netname', setter: fld_set}]},
    'paddr': {convert: to_ip, to:[{field: 'rsa.network.paddr', setter: fld_set},{field: 'related.ip', setter: fld_append}]},
    'calling_from': {to:[{field: 'rsa.misc.phone', setter: fld_prio, prio: 1}]},
    'sigid1': {convert: to_long, to:[{field: 'rsa.misc.sig_id1', setter: fld_set}]},
    's_sslver': {to:[{field: 'rsa.crypto.ssl_ver_src', setter: fld_set}]},
    'trans_from': {to:[{field: 'rsa.email.trans_from', setter: fld_set}]},
    'web_ref_page': {to:[{field: 'rsa.web.web_ref_page', setter: fld_set}]},
    'web_ref_root': {to:[{field: 'rsa.web.web_ref_root', setter: fld_set}]},
    'wlan': {to:[{field: 'rsa.wireless.wlan_name', setter: fld_set}]},
    'd_certauth': {to:[{field: 'rsa.crypto.d_certauth', setter: fld_set}]},
    'faddr': {to:[{field: 'rsa.network.faddr', setter: fld_set}]},
    'hour': {to:[{field: 'rsa.time.hour', setter: fld_set}]},
    'im_buddyid': {to:[{field: 'rsa.misc.im_buddyid', setter: fld_set}]},
    'im_client': {to:[{field: 'rsa.misc.im_client', setter: fld_set}]},
    'im_userid': {to:[{field: 'rsa.misc.im_userid', setter: fld_set}]},
    'lhost': {to:[{field: 'rsa.network.lhost', setter: fld_set}]},
    'min': {to:[{field: 'rsa.time.min', setter: fld_set}]},
    'origin': {to:[{field: 'rsa.network.origin', setter: fld_set}]},
    'pid': {to:[{field: 'rsa.misc.pid', setter: fld_set}]},
    'priority': {to:[{field: 'rsa.misc.priority', setter: fld_set}]},
    'remote_domain_id': {to:[{field: 'rsa.network.remote_domain_id', setter: fld_set}]},
    's_certauth': {to:[{field: 'rsa.crypto.s_certauth', setter: fld_set}]},
    'timestamp': {to:[{field: 'rsa.time.timestamp', setter: fld_set}]},
    'attachment': {to:[{field: 'rsa.file.attachment', setter: fld_set}]},
    's_context': {to:[{field: 'rsa.misc.context_subject', setter: fld_set}]},
    't_context': {to:[{field: 'rsa.misc.context_target', setter: fld_set}]},
    'cve': {to:[{field: 'rsa.misc.cve', setter: fld_set}]},
    'dclass_counter2_string': {to:[{field: 'rsa.counters.dclass_c2_str', setter: fld_set}]},
    'dclass_ratio1_string': {to:[{field: 'rsa.counters.dclass_r1_str', setter: fld_set}]},
    'dclass_ratio2': {to:[{field: 'rsa.counters.dclass_r2', setter: fld_set}]},
    'event_queue_time': {convert: to_date, to:[{field: 'rsa.time.event_queue_time', setter: fld_set}]},
    'fcatnum': {to:[{field: 'rsa.misc.fcatnum', setter: fld_set}]},
    'federated_idp': {to:[{field: 'rsa.identity.federated_idp', setter: fld_set}]},
    'h_code': {to:[{field: 'rsa.internal.hcode', setter: fld_set}]},
    'ike_cookie1': {to:[{field: 'rsa.crypto.ike_cookie1', setter: fld_set}]},
    'ike_cookie2': {to:[{field: 'rsa.crypto.ike_cookie2', setter: fld_set}]},
    'inode': {convert: to_long, to:[{field: 'rsa.internal.inode', setter: fld_set}]},
    'library': {to:[{field: 'rsa.misc.library', setter: fld_set}]},
    'lread': {convert: to_long, to:[{field: 'rsa.db.lread', setter: fld_set}]},
    'lwrite': {convert: to_long, to:[{field: 'rsa.db.lwrite', setter: fld_set}]},
    'parent_node': {to:[{field: 'rsa.misc.parent_node', setter: fld_set}]},
    'phone_number': {to:[{field: 'rsa.misc.phone', setter: fld_prio, prio: 2}]},
    'pwwn': {to:[{field: 'rsa.storage.pwwn', setter: fld_set}]},
    'resource_class': {to:[{field: 'rsa.internal.resource_class', setter: fld_set}]},
    'risk_info': {to:[{field: 'rsa.misc.risk_info', setter: fld_set}]},
    'tcp_flags': {convert: to_long, to:[{field: 'rsa.misc.tcp_flags', setter: fld_set}]},
    'tos': {convert: to_long, to:[{field: 'rsa.misc.tos', setter: fld_set}]},
    'trans_to': {to:[{field: 'rsa.email.trans_to', setter: fld_set}]},
    'vm_target': {to:[{field: 'rsa.misc.vm_target', setter: fld_set}]},
    'workspace_desc': {to:[{field: 'rsa.misc.workspace', setter: fld_set}]},
    'addr': {to:[{field: 'rsa.network.addr', setter: fld_set}]},
    'cn_asn_dst': {to:[{field: 'rsa.web.cn_asn_dst', setter: fld_set}]},
    'cn_rpackets': {to:[{field: 'rsa.web.cn_rpackets', setter: fld_set}]},
    'command': {to:[{field: 'rsa.misc.command', setter: fld_set}]},
    'dns_a_record': {to:[{field: 'rsa.network.dns_a_record', setter: fld_set}]},
    'dns_ptr_record': {to:[{field: 'rsa.network.dns_ptr_record', setter: fld_set}]},
    'event_category': {to:[{field: 'rsa.misc.event_category', setter: fld_set}]},
    'facilityname': {to:[{field: 'rsa.misc.facilityname', setter: fld_set}]},
    'fhost': {to:[{field: 'rsa.network.fhost', setter: fld_set}]},
    'filesystem': {to:[{field: 'rsa.file.filesystem', setter: fld_set}]},
    'forensic_info': {to:[{field: 'rsa.misc.forensic_info', setter: fld_set}]},
    'fport': {to:[{field: 'rsa.network.fport', setter: fld_set}]},
    'jobname': {to:[{field: 'rsa.misc.jobname', setter: fld_set}]},
    'laddr': {to:[{field: 'rsa.network.laddr', setter: fld_set}]},
    'linterface': {to:[{field: 'rsa.network.linterface', setter: fld_set}]},
    'mode': {to:[{field: 'rsa.misc.mode', setter: fld_set}]},
    'p_time1': {to:[{field: 'rsa.time.p_time1', setter: fld_set}]},
    'phost': {to:[{field: 'rsa.network.phost', setter: fld_set}]},
    'policy': {to:[{field: 'rsa.misc.policy', setter: fld_set}]},
    'policy_waiver': {to:[{field: 'rsa.misc.policy_waiver', setter: fld_set}]},
    'second': {to:[{field: 'rsa.misc.second', setter: fld_set}]},
    'space1': {to:[{field: 'rsa.misc.space1', setter: fld_set}]},
    'subcategory': {to:[{field: 'rsa.misc.subcategory', setter: fld_set}]},
    'tbdstr2': {to:[{field: 'rsa.misc.tbdstr2', setter: fld_set}]},
    'tzone': {to:[{field: 'rsa.time.tzone', setter: fld_set}]},
    'urlpage': {to:[{field: 'rsa.web.urlpage', setter: fld_set}]},
    'urlroot': {to:[{field: 'rsa.web.urlroot', setter: fld_set}]},
    'ad_computer_dst': {to:[{field: 'rsa.network.ad_computer_dst', setter: fld_set}]},
    'alert': {to:[{field: 'rsa.threat.alert', setter: fld_set}]},
    'alert_id': {to:[{field: 'rsa.misc.alert_id', setter: fld_set}]},
    'devicehostname': {to:[{field: 'rsa.network.alias_host', setter: fld_append}]},
    'binary': {to:[{field: 'rsa.file.binary', setter: fld_set}]},
    'cert_checksum': {to:[{field: 'rsa.crypto.cert_checksum', setter: fld_set}]},
    'cert_hostname_cat': {to:[{field: 'rsa.crypto.cert_host_cat', setter: fld_set}]},
    'cert.serial': {to:[{field: 'rsa.crypto.cert_serial', setter: fld_set}]},
    'cert_status': {to:[{field: 'rsa.crypto.cert_status', setter: fld_set}]},
    'checksum.dst': {to:[{field: 'rsa.misc.checksum_dst', setter: fld_set}]},
    'checksum.src': {to:[{field: 'rsa.misc.checksum_src', setter: fld_set}]},
    'dclass_counter3_string': {to:[{field: 'rsa.counters.dclass_c3_str', setter: fld_set}]},
    'dclass_ratio3': {to:[{field: 'rsa.counters.dclass_r3', setter: fld_set}]},
    'dead': {convert: to_long, to:[{field: 'rsa.internal.dead', setter: fld_set}]},
    'bcc': {to:[{field: 'rsa.email.email', setter: fld_append}]},
    'email': {to:[{field: 'rsa.email.email', setter: fld_append}]},
    'eth_type': {convert: to_long, to:[{field: 'rsa.network.eth_type', setter: fld_set}]},
    'feed_desc': {to:[{field: 'rsa.internal.feed_desc', setter: fld_set}]},
    'feed_name': {to:[{field: 'rsa.internal.feed_name', setter: fld_set}]},
    'filename_dst': {to:[{field: 'rsa.file.filename_dst', setter: fld_set}]},
    'filename_src': {to:[{field: 'rsa.file.filename_src', setter: fld_set}]},
    'fresult': {convert: to_long, to:[{field: 'rsa.misc.fresult', setter: fld_set}]},
    'ip_proto': {convert: to_long, to:[{field: 'rsa.network.ip_proto', setter: fld_set}]},
    'logon_type_desc': {to:[{field: 'rsa.identity.logon_type_desc', setter: fld_set}]},
    'user_mname': {to:[{field: 'rsa.identity.middlename', setter: fld_set}]},
    'org_dst': {to:[{field: 'rsa.physical.org_dst', setter: fld_prio, prio: 0}]},
    'password': {to:[{field: 'rsa.identity.password', setter: fld_set}]},
    'patient_fname': {to:[{field: 'rsa.healthcare.patient_fname', setter: fld_set}]},
    'patient_id': {to:[{field: 'rsa.healthcare.patient_id', setter: fld_set}]},
    'patient_lname': {to:[{field: 'rsa.healthcare.patient_lname', setter: fld_set}]},
    'patient_mname': {to:[{field: 'rsa.healthcare.patient_mname', setter: fld_set}]},
    'dst_payload': {to:[{field: 'rsa.misc.payload_dst', setter: fld_set}]},
    'src_payload': {to:[{field: 'rsa.misc.payload_src', setter: fld_set}]},
    'pool_id': {to:[{field: 'rsa.misc.pool_id', setter: fld_set}]},
    'pread': {convert: to_long, to:[{field: 'rsa.db.pread', setter: fld_set}]},
    'process_id_val': {to:[{field: 'rsa.misc.process_id_val', setter: fld_set}]},
    'risk_num_comm': {convert: to_double, to:[{field: 'rsa.misc.risk_num_comm', setter: fld_set}]},
    'risk_num_next': {convert: to_double, to:[{field: 'rsa.misc.risk_num_next', setter: fld_set}]},
    'risk_num_sand': {convert: to_double, to:[{field: 'rsa.misc.risk_num_sand', setter: fld_set}]},
    'risk_num_static': {convert: to_double, to:[{field: 'rsa.misc.risk_num_static', setter: fld_set}]},
    'risk_suspicious': {to:[{field: 'rsa.misc.risk_suspicious', setter: fld_set}]},
    'risk_warning': {to:[{field: 'rsa.misc.risk_warning', setter: fld_set}]},
    'snmp.oid': {to:[{field: 'rsa.misc.snmp_oid', setter: fld_set}]},
    'sql': {to:[{field: 'rsa.misc.sql', setter: fld_set}]},
    'd_sslver': {to:[{field: 'rsa.crypto.ssl_ver_dst', setter: fld_set}]},
    'threat_source': {to:[{field: 'rsa.threat.threat_source', setter: fld_set}]},
    'vuln_ref': {to:[{field: 'rsa.misc.vuln_ref', setter: fld_set}]},
    'acl_id': {to:[{field: 'rsa.misc.acl_id', setter: fld_set}]},
    'acl_op': {to:[{field: 'rsa.misc.acl_op', setter: fld_set}]},
    'acl_pos': {to:[{field: 'rsa.misc.acl_pos', setter: fld_set}]},
    'acl_table': {to:[{field: 'rsa.misc.acl_table', setter: fld_set}]},
    'admin': {to:[{field: 'rsa.misc.admin', setter: fld_set}]},
    'alarm_id': {to:[{field: 'rsa.misc.alarm_id', setter: fld_set}]},
    'alarmname': {to:[{field: 'rsa.misc.alarmname', setter: fld_set}]},
    'app_id': {to:[{field: 'rsa.misc.app_id', setter: fld_set}]},
    'audit': {to:[{field: 'rsa.misc.audit', setter: fld_set}]},
    'audit_object': {to:[{field: 'rsa.misc.audit_object', setter: fld_set}]},
    'auditdata': {to:[{field: 'rsa.misc.auditdata', setter: fld_set}]},
    'benchmark': {to:[{field: 'rsa.misc.benchmark', setter: fld_set}]},
    'bypass': {to:[{field: 'rsa.misc.bypass', setter: fld_set}]},
    'cache': {to:[{field: 'rsa.misc.cache', setter: fld_set}]},
    'cache_hit': {to:[{field: 'rsa.misc.cache_hit', setter: fld_set}]},
    'cefversion': {to:[{field: 'rsa.misc.cefversion', setter: fld_set}]},
    'cert_keysize': {to:[{field: 'rsa.crypto.cert_keysize', setter: fld_set}]},
    'cert_username': {to:[{field: 'rsa.crypto.cert_username', setter: fld_set}]},
    'cfg.attr': {to:[{field: 'rsa.misc.cfg_attr', setter: fld_set}]},
    'cfg.obj': {to:[{field: 'rsa.misc.cfg_obj', setter: fld_set}]},
    'cfg.path': {to:[{field: 'rsa.misc.cfg_path', setter: fld_set}]},
    'changes': {to:[{field: 'rsa.misc.changes', setter: fld_set}]},
    'client': {to:[{field: 'rsa.misc.client', setter: fld_prio, prio: 1}]},
    'client_ip': {to:[{field: 'rsa.misc.client_ip', setter: fld_set}]},
    'clustermembers': {to:[{field: 'rsa.misc.clustermembers', setter: fld_set}]},
    'cn_acttimeout': {to:[{field: 'rsa.misc.cn_acttimeout', setter: fld_set}]},
    'cn_asn_src': {to:[{field: 'rsa.misc.cn_asn_src', setter: fld_set}]},
    'cn_bgpv4nxthop': {to:[{field: 'rsa.misc.cn_bgpv4nxthop', setter: fld_set}]},
    'cn_ctr_dst_code': {to:[{field: 'rsa.misc.cn_ctr_dst_code', setter: fld_set}]},
    'cn_dst_tos': {to:[{field: 'rsa.misc.cn_dst_tos', setter: fld_set}]},
    'cn_dst_vlan': {to:[{field: 'rsa.misc.cn_dst_vlan', setter: fld_set}]},
    'cn_engine_id': {to:[{field: 'rsa.misc.cn_engine_id', setter: fld_set}]},
    'cn_engine_type': {to:[{field: 'rsa.misc.cn_engine_type', setter: fld_set}]},
    'cn_f_switch': {to:[{field: 'rsa.misc.cn_f_switch', setter: fld_set}]},
    'cn_flowsampid': {to:[{field: 'rsa.misc.cn_flowsampid', setter: fld_set}]},
    'cn_flowsampintv': {to:[{field: 'rsa.misc.cn_flowsampintv', setter: fld_set}]},
    'cn_flowsampmode': {to:[{field: 'rsa.misc.cn_flowsampmode', setter: fld_set}]},
    'cn_inacttimeout': {to:[{field: 'rsa.misc.cn_inacttimeout', setter: fld_set}]},
    'cn_inpermbyts': {to:[{field: 'rsa.misc.cn_inpermbyts', setter: fld_set}]},
    'cn_inpermpckts': {to:[{field: 'rsa.misc.cn_inpermpckts', setter: fld_set}]},
    'cn_invalid': {to:[{field: 'rsa.misc.cn_invalid', setter: fld_set}]},
    'cn_ip_proto_ver': {to:[{field: 'rsa.misc.cn_ip_proto_ver', setter: fld_set}]},
    'cn_ipv4_ident': {to:[{field: 'rsa.misc.cn_ipv4_ident', setter: fld_set}]},
    'cn_l_switch': {to:[{field: 'rsa.misc.cn_l_switch', setter: fld_set}]},
    'cn_log_did': {to:[{field: 'rsa.misc.cn_log_did', setter: fld_set}]},
    'cn_log_rid': {to:[{field: 'rsa.misc.cn_log_rid', setter: fld_set}]},
    'cn_max_ttl': {to:[{field: 'rsa.misc.cn_max_ttl', setter: fld_set}]},
    'cn_maxpcktlen': {to:[{field: 'rsa.misc.cn_maxpcktlen', setter: fld_set}]},
    'cn_min_ttl': {to:[{field: 'rsa.misc.cn_min_ttl', setter: fld_set}]},
    'cn_minpcktlen': {to:[{field: 'rsa.misc.cn_minpcktlen', setter: fld_set}]},
    'cn_mpls_lbl_1': {to:[{field: 'rsa.misc.cn_mpls_lbl_1', setter: fld_set}]},
    'cn_mpls_lbl_10': {to:[{field: 'rsa.misc.cn_mpls_lbl_10', setter: fld_set}]},
    'cn_mpls_lbl_2': {to:[{field: 'rsa.misc.cn_mpls_lbl_2', setter: fld_set}]},
    'cn_mpls_lbl_3': {to:[{field: 'rsa.misc.cn_mpls_lbl_3', setter: fld_set}]},
    'cn_mpls_lbl_4': {to:[{field: 'rsa.misc.cn_mpls_lbl_4', setter: fld_set}]},
    'cn_mpls_lbl_5': {to:[{field: 'rsa.misc.cn_mpls_lbl_5', setter: fld_set}]},
    'cn_mpls_lbl_6': {to:[{field: 'rsa.misc.cn_mpls_lbl_6', setter: fld_set}]},
    'cn_mpls_lbl_7': {to:[{field: 'rsa.misc.cn_mpls_lbl_7', setter: fld_set}]},
    'cn_mpls_lbl_8': {to:[{field: 'rsa.misc.cn_mpls_lbl_8', setter: fld_set}]},
    'cn_mpls_lbl_9': {to:[{field: 'rsa.misc.cn_mpls_lbl_9', setter: fld_set}]},
    'cn_mplstoplabel': {to:[{field: 'rsa.misc.cn_mplstoplabel', setter: fld_set}]},
    'cn_mplstoplabip': {to:[{field: 'rsa.misc.cn_mplstoplabip', setter: fld_set}]},
    'cn_mul_dst_byt': {to:[{field: 'rsa.misc.cn_mul_dst_byt', setter: fld_set}]},
    'cn_mul_dst_pks': {to:[{field: 'rsa.misc.cn_mul_dst_pks', setter: fld_set}]},
    'cn_muligmptype': {to:[{field: 'rsa.misc.cn_muligmptype', setter: fld_set}]},
    'cn_sampalgo': {to:[{field: 'rsa.misc.cn_sampalgo', setter: fld_set}]},
    'cn_sampint': {to:[{field: 'rsa.misc.cn_sampint', setter: fld_set}]},
    'cn_seqctr': {to:[{field: 'rsa.misc.cn_seqctr', setter: fld_set}]},
    'cn_spackets': {to:[{field: 'rsa.misc.cn_spackets', setter: fld_set}]},
    'cn_src_tos': {to:[{field: 'rsa.misc.cn_src_tos', setter: fld_set}]},
    'cn_src_vlan': {to:[{field: 'rsa.misc.cn_src_vlan', setter: fld_set}]},
    'cn_sysuptime': {to:[{field: 'rsa.misc.cn_sysuptime', setter: fld_set}]},
    'cn_template_id': {to:[{field: 'rsa.misc.cn_template_id', setter: fld_set}]},
    'cn_totbytsexp': {to:[{field: 'rsa.misc.cn_totbytsexp', setter: fld_set}]},
    'cn_totflowexp': {to:[{field: 'rsa.misc.cn_totflowexp', setter: fld_set}]},
    'cn_totpcktsexp': {to:[{field: 'rsa.misc.cn_totpcktsexp', setter: fld_set}]},
    'cn_unixnanosecs': {to:[{field: 'rsa.misc.cn_unixnanosecs', setter: fld_set}]},
    'cn_v6flowlabel': {to:[{field: 'rsa.misc.cn_v6flowlabel', setter: fld_set}]},
    'cn_v6optheaders': {to:[{field: 'rsa.misc.cn_v6optheaders', setter: fld_set}]},
    'comp_class': {to:[{field: 'rsa.misc.comp_class', setter: fld_set}]},
    'comp_name': {to:[{field: 'rsa.misc.comp_name', setter: fld_set}]},
    'comp_rbytes': {to:[{field: 'rsa.misc.comp_rbytes', setter: fld_set}]},
    'comp_sbytes': {to:[{field: 'rsa.misc.comp_sbytes', setter: fld_set}]},
    'connection_id': {to:[{field: 'rsa.misc.connection_id', setter: fld_prio, prio: 1}]},
    'cpu_data': {to:[{field: 'rsa.misc.cpu_data', setter: fld_set}]},
    'criticality': {to:[{field: 'rsa.misc.criticality', setter: fld_set}]},
    'cs_agency_dst': {to:[{field: 'rsa.misc.cs_agency_dst', setter: fld_set}]},
    'cs_analyzedby': {to:[{field: 'rsa.misc.cs_analyzedby', setter: fld_set}]},
    'cs_av_other': {to:[{field: 'rsa.misc.cs_av_other', setter: fld_set}]},
    'cs_av_primary': {to:[{field: 'rsa.misc.cs_av_primary', setter: fld_set}]},
    'cs_av_secondary': {to:[{field: 'rsa.misc.cs_av_secondary', setter: fld_set}]},
    'cs_bgpv6nxthop': {to:[{field: 'rsa.misc.cs_bgpv6nxthop', setter: fld_set}]},
    'cs_bit9status': {to:[{field: 'rsa.misc.cs_bit9status', setter: fld_set}]},
    'cs_context': {to:[{field: 'rsa.misc.cs_context', setter: fld_set}]},
    'cs_control': {to:[{field: 'rsa.misc.cs_control', setter: fld_set}]},
    'cs_data': {to:[{field: 'rsa.misc.cs_data', setter: fld_set}]},
    'cs_datecret': {to:[{field: 'rsa.misc.cs_datecret', setter: fld_set}]},
    'cs_dst_tld': {to:[{field: 'rsa.misc.cs_dst_tld', setter: fld_set}]},
    'cs_eth_dst_ven': {to:[{field: 'rsa.misc.cs_eth_dst_ven', setter: fld_set}]},
    'cs_eth_src_ven': {to:[{field: 'rsa.misc.cs_eth_src_ven', setter: fld_set}]},
    'cs_event_uuid': {to:[{field: 'rsa.misc.cs_event_uuid', setter: fld_set}]},
    'cs_filetype': {to:[{field: 'rsa.misc.cs_filetype', setter: fld_set}]},
    'cs_fld': {to:[{field: 'rsa.misc.cs_fld', setter: fld_set}]},
    'cs_if_desc': {to:[{field: 'rsa.misc.cs_if_desc', setter: fld_set}]},
    'cs_if_name': {to:[{field: 'rsa.misc.cs_if_name', setter: fld_set}]},
    'cs_ip_next_hop': {to:[{field: 'rsa.misc.cs_ip_next_hop', setter: fld_set}]},
    'cs_ipv4dstpre': {to:[{field: 'rsa.misc.cs_ipv4dstpre', setter: fld_set}]},
    'cs_ipv4srcpre': {to:[{field: 'rsa.misc.cs_ipv4srcpre', setter: fld_set}]},
    'cs_lifetime': {to:[{field: 'rsa.misc.cs_lifetime', setter: fld_set}]},
    'cs_log_medium': {to:[{field: 'rsa.misc.cs_log_medium', setter: fld_set}]},
    'cs_loginname': {to:[{field: 'rsa.misc.cs_loginname', setter: fld_set}]},
    'cs_modulescore': {to:[{field: 'rsa.misc.cs_modulescore', setter: fld_set}]},
    'cs_modulesign': {to:[{field: 'rsa.misc.cs_modulesign', setter: fld_set}]},
    'cs_opswatresult': {to:[{field: 'rsa.misc.cs_opswatresult', setter: fld_set}]},
    'cs_payload': {to:[{field: 'rsa.misc.cs_payload', setter: fld_set}]},
    'cs_registrant': {to:[{field: 'rsa.misc.cs_registrant', setter: fld_set}]},
    'cs_registrar': {to:[{field: 'rsa.misc.cs_registrar', setter: fld_set}]},
    'cs_represult': {to:[{field: 'rsa.misc.cs_represult', setter: fld_set}]},
    'cs_rpayload': {to:[{field: 'rsa.misc.cs_rpayload', setter: fld_set}]},
    'cs_sampler_name': {to:[{field: 'rsa.misc.cs_sampler_name', setter: fld_set}]},
    'cs_sourcemodule': {to:[{field: 'rsa.misc.cs_sourcemodule', setter: fld_set}]},
    'cs_streams': {to:[{field: 'rsa.misc.cs_streams', setter: fld_set}]},
    'cs_targetmodule': {to:[{field: 'rsa.misc.cs_targetmodule', setter: fld_set}]},
    'cs_v6nxthop': {to:[{field: 'rsa.misc.cs_v6nxthop', setter: fld_set}]},
    'cs_whois_server': {to:[{field: 'rsa.misc.cs_whois_server', setter: fld_set}]},
    'cs_yararesult': {to:[{field: 'rsa.misc.cs_yararesult', setter: fld_set}]},
    'description': {to:[{field: 'rsa.misc.description', setter: fld_set}]},
    'devvendor': {to:[{field: 'rsa.misc.devvendor', setter: fld_set}]},
    'distance': {to:[{field: 'rsa.misc.distance', setter: fld_set}]},
    'dns_cname_record': {to:[{field: 'rsa.network.dns_cname_record', setter: fld_set}]},
    'dns_id': {to:[{field: 'rsa.network.dns_id', setter: fld_set}]},
    'dns_opcode': {to:[{field: 'rsa.network.dns_opcode', setter: fld_set}]},
    'dns_resp': {to:[{field: 'rsa.network.dns_resp', setter: fld_set}]},
    'dns_type': {to:[{field: 'rsa.network.dns_type', setter: fld_set}]},
    'domain1': {to:[{field: 'rsa.network.domain1', setter: fld_set}]},
    'dstburb': {to:[{field: 'rsa.misc.dstburb', setter: fld_set}]},
    'edomain': {to:[{field: 'rsa.misc.edomain', setter: fld_set}]},
    'edomaub': {to:[{field: 'rsa.misc.edomaub', setter: fld_set}]},
    'euid': {to:[{field: 'rsa.misc.euid', setter: fld_set}]},
    'event_time_str': {to:[{field: 'rsa.time.event_time_str', setter: fld_prio, prio: 1}]},
    'eventtime': {to:[{field: 'rsa.time.eventtime', setter: fld_set}]},
    'facility': {to:[{field: 'rsa.misc.facility', setter: fld_set}]},
    'filename_tmp': {to:[{field: 'rsa.file.filename_tmp', setter: fld_set}]},
    'finterface': {to:[{field: 'rsa.misc.finterface', setter: fld_set}]},
    'flags': {to:[{field: 'rsa.misc.flags', setter: fld_set}]},
    'gaddr': {to:[{field: 'rsa.misc.gaddr', setter: fld_set}]},
    'gmtdate': {to:[{field: 'rsa.time.gmtdate', setter: fld_set}]},
    'gmttime': {to:[{field: 'rsa.time.gmttime', setter: fld_set}]},
    'host.type': {to:[{field: 'rsa.network.host_type', setter: fld_set}]},
    'https.insact': {to:[{field: 'rsa.crypto.https_insact', setter: fld_set}]},
    'https.valid': {to:[{field: 'rsa.crypto.https_valid', setter: fld_set}]},
    'id3': {to:[{field: 'rsa.misc.id3', setter: fld_set}]},
    'im_buddyname': {to:[{field: 'rsa.misc.im_buddyname', setter: fld_set}]},
    'im_croomid': {to:[{field: 'rsa.misc.im_croomid', setter: fld_set}]},
    'im_croomtype': {to:[{field: 'rsa.misc.im_croomtype', setter: fld_set}]},
    'im_members': {to:[{field: 'rsa.misc.im_members', setter: fld_set}]},
    'im_username': {to:[{field: 'rsa.misc.im_username', setter: fld_set}]},
    'ipkt': {to:[{field: 'rsa.misc.ipkt', setter: fld_set}]},
    'ipscat': {to:[{field: 'rsa.misc.ipscat', setter: fld_set}]},
    'ipspri': {to:[{field: 'rsa.misc.ipspri', setter: fld_set}]},
    'latitude': {to:[{field: 'rsa.misc.latitude', setter: fld_set}]},
    'linenum': {to:[{field: 'rsa.misc.linenum', setter: fld_set}]},
    'list_name': {to:[{field: 'rsa.misc.list_name', setter: fld_set}]},
    'load_data': {to:[{field: 'rsa.misc.load_data', setter: fld_set}]},
    'location_floor': {to:[{field: 'rsa.misc.location_floor', setter: fld_set}]},
    'location_mark': {to:[{field: 'rsa.misc.location_mark', setter: fld_set}]},
    'log_id': {to:[{field: 'rsa.misc.log_id', setter: fld_set}]},
    'log_type': {to:[{field: 'rsa.misc.log_type', setter: fld_set}]},
    'logid': {to:[{field: 'rsa.misc.logid', setter: fld_set}]},
    'logip': {to:[{field: 'rsa.misc.logip', setter: fld_set}]},
    'logname': {to:[{field: 'rsa.misc.logname', setter: fld_set}]},
    'longitude': {to:[{field: 'rsa.misc.longitude', setter: fld_set}]},
    'lport': {to:[{field: 'rsa.misc.lport', setter: fld_set}]},
    'mbug_data': {to:[{field: 'rsa.misc.mbug_data', setter: fld_set}]},
    'misc_name': {to:[{field: 'rsa.misc.misc_name', setter: fld_set}]},
    'msg_type': {to:[{field: 'rsa.misc.msg_type', setter: fld_set}]},
    'msgid': {to:[{field: 'rsa.misc.msgid', setter: fld_set}]},
    'netsessid': {to:[{field: 'rsa.misc.netsessid', setter: fld_set}]},
    'num': {to:[{field: 'rsa.misc.num', setter: fld_set}]},
    'number1': {to:[{field: 'rsa.misc.number1', setter: fld_set}]},
    'number2': {to:[{field: 'rsa.misc.number2', setter: fld_set}]},
    'nwwn': {to:[{field: 'rsa.misc.nwwn', setter: fld_set}]},
    'object': {to:[{field: 'rsa.misc.object', setter: fld_set}]},
    'operation': {to:[{field: 'rsa.misc.operation', setter: fld_set}]},
    'opkt': {to:[{field: 'rsa.misc.opkt', setter: fld_set}]},
    'orig_from': {to:[{field: 'rsa.misc.orig_from', setter: fld_set}]},
    'owner_id': {to:[{field: 'rsa.misc.owner_id', setter: fld_set}]},
    'p_action': {to:[{field: 'rsa.misc.p_action', setter: fld_set}]},
    'p_date': {to:[{field: 'rsa.time.p_date', setter: fld_set}]},
    'p_filter': {to:[{field: 'rsa.misc.p_filter', setter: fld_set}]},
    'p_group_object': {to:[{field: 'rsa.misc.p_group_object', setter: fld_set}]},
    'p_id': {to:[{field: 'rsa.misc.p_id', setter: fld_set}]},
    'p_month': {to:[{field: 'rsa.time.p_month', setter: fld_set}]},
    'p_msgid1': {to:[{field: 'rsa.misc.p_msgid1', setter: fld_set}]},
    'p_msgid2': {to:[{field: 'rsa.misc.p_msgid2', setter: fld_set}]},
    'p_result1': {to:[{field: 'rsa.misc.p_result1', setter: fld_set}]},
    'p_time': {to:[{field: 'rsa.time.p_time', setter: fld_set}]},
    'p_time2': {to:[{field: 'rsa.time.p_time2', setter: fld_set}]},
    'p_url': {to:[{field: 'rsa.web.p_url', setter: fld_set}]},
    'p_user_agent': {to:[{field: 'rsa.web.p_user_agent', setter: fld_set}]},
    'p_web_cookie': {to:[{field: 'rsa.web.p_web_cookie', setter: fld_set}]},
    'p_web_method': {to:[{field: 'rsa.web.p_web_method', setter: fld_set}]},
    'p_web_referer': {to:[{field: 'rsa.web.p_web_referer', setter: fld_set}]},
    'p_year': {to:[{field: 'rsa.time.p_year', setter: fld_set}]},
    'packet_length': {to:[{field: 'rsa.network.packet_length', setter: fld_set}]},
    'password_chg': {to:[{field: 'rsa.misc.password_chg', setter: fld_set}]},
    'password_expire': {to:[{field: 'rsa.misc.password_expire', setter: fld_set}]},
    'permgranted': {to:[{field: 'rsa.misc.permgranted', setter: fld_set}]},
    'permwanted': {to:[{field: 'rsa.misc.permwanted', setter: fld_set}]},
    'pgid': {to:[{field: 'rsa.misc.pgid', setter: fld_set}]},
    'policyUUID': {to:[{field: 'rsa.misc.policyUUID', setter: fld_set}]},
    'prog_asp_num': {to:[{field: 'rsa.misc.prog_asp_num', setter: fld_set}]},
    'program': {to:[{field: 'rsa.misc.program', setter: fld_set}]},
    'real_data': {to:[{field: 'rsa.misc.real_data', setter: fld_set}]},
    'rec_asp_device': {to:[{field: 'rsa.misc.rec_asp_device', setter: fld_set}]},
    'rec_asp_num': {to:[{field: 'rsa.misc.rec_asp_num', setter: fld_set}]},
    'rec_library': {to:[{field: 'rsa.misc.rec_library', setter: fld_set}]},
    'recordnum': {to:[{field: 'rsa.misc.recordnum', setter: fld_set}]},
    'result_code': {to:[{field: 'rsa.misc.result_code', setter: fld_prio, prio: 1}]},
    'ruid': {to:[{field: 'rsa.misc.ruid', setter: fld_set}]},
    'sburb': {to:[{field: 'rsa.misc.sburb', setter: fld_set}]},
    'sdomain_fld': {to:[{field: 'rsa.misc.sdomain_fld', setter: fld_set}]},
    'sec': {to:[{field: 'rsa.misc.sec', setter: fld_set}]},
    'sensorname': {to:[{field: 'rsa.misc.sensorname', setter: fld_set}]},
    'seqnum': {to:[{field: 'rsa.misc.seqnum', setter: fld_set}]},
    'session': {to:[{field: 'rsa.misc.session', setter: fld_set}]},
    'sessiontype': {to:[{field: 'rsa.misc.sessiontype', setter: fld_set}]},
    'sigUUID': {to:[{field: 'rsa.misc.sigUUID', setter: fld_set}]},
    'spi': {to:[{field: 'rsa.misc.spi', setter: fld_set}]},
    'srcburb': {to:[{field: 'rsa.misc.srcburb', setter: fld_set}]},
    'srcdom': {to:[{field: 'rsa.misc.srcdom', setter: fld_set}]},
    'srcservice': {to:[{field: 'rsa.misc.srcservice', setter: fld_set}]},
    'state': {to:[{field: 'rsa.misc.state', setter: fld_set}]},
    'status1': {to:[{field: 'rsa.misc.status1', setter: fld_set}]},
    'svcno': {to:[{field: 'rsa.misc.svcno', setter: fld_set}]},
    'system': {to:[{field: 'rsa.misc.system', setter: fld_set}]},
    'tbdstr1': {to:[{field: 'rsa.misc.tbdstr1', setter: fld_set}]},
    'tgtdom': {to:[{field: 'rsa.misc.tgtdom', setter: fld_set}]},
    'tgtdomain': {to:[{field: 'rsa.misc.tgtdomain', setter: fld_set}]},
    'threshold': {to:[{field: 'rsa.misc.threshold', setter: fld_set}]},
    'type1': {to:[{field: 'rsa.misc.type1', setter: fld_set}]},
    'udb_class': {to:[{field: 'rsa.misc.udb_class', setter: fld_set}]},
    'url_fld': {to:[{field: 'rsa.misc.url_fld', setter: fld_set}]},
    'user_div': {to:[{field: 'rsa.misc.user_div', setter: fld_set}]},
    'userid': {to:[{field: 'rsa.misc.userid', setter: fld_set}]},
    'username_fld': {to:[{field: 'rsa.misc.username_fld', setter: fld_set}]},
    'utcstamp': {to:[{field: 'rsa.misc.utcstamp', setter: fld_set}]},
    'v_instafname': {to:[{field: 'rsa.misc.v_instafname', setter: fld_set}]},
    'virt_data': {to:[{field: 'rsa.misc.virt_data', setter: fld_set}]},
    'vpnid': {to:[{field: 'rsa.misc.vpnid', setter: fld_set}]},
    'web_extension_tmp': {to:[{field: 'rsa.web.web_extension_tmp', setter: fld_set}]},
    'web_page': {to:[{field: 'rsa.web.web_page', setter: fld_set}]},
    'alias.host': {to:[{field: 'rsa.network.alias_host', setter: fld_append}]},
    'workstation': {to:[{field: 'rsa.network.alias_host', setter: fld_append}]},
    'analysis.file': {to:[{field: 'rsa.investigations.analysis_file', setter: fld_set}]},
    'analysis.service': {to:[{field: 'rsa.investigations.analysis_service', setter: fld_set}]},
    'analysis.session': {to:[{field: 'rsa.investigations.analysis_session', setter: fld_set}]},
    'autorun_type': {to:[{field: 'rsa.misc.autorun_type', setter: fld_set}]},
    'boc': {to:[{field: 'rsa.investigations.boc', setter: fld_set}]},
    'cc.number': {convert: to_long, to:[{field: 'rsa.misc.cc_number', setter: fld_set}]},
    'cert_ca': {to:[{field: 'rsa.crypto.cert_ca', setter: fld_set}]},
    'cert_common': {to:[{field: 'rsa.crypto.cert_common', setter: fld_set}]},
    'cid': {to:[{field: 'rsa.internal.cid', setter: fld_set}]},
    'content': {to:[{field: 'rsa.misc.content', setter: fld_set}]},
    'dclass_ratio2_string': {to:[{field: 'rsa.counters.dclass_r2_str', setter: fld_set}]},
    'dclass_ratio3_string': {to:[{field: 'rsa.counters.dclass_r3_str', setter: fld_set}]},
    'device.class': {to:[{field: 'rsa.internal.device_class', setter: fld_set}]},
    'device.group': {to:[{field: 'rsa.internal.device_group', setter: fld_set}]},
    'device.host': {to:[{field: 'rsa.internal.device_host', setter: fld_set}]},
    'device.ip': {convert: to_ip, to:[{field: 'rsa.internal.device_ip', setter: fld_set},{field: 'related.ip', setter: fld_append}]},
    'device.ipv6': {convert: to_ip, to:[{field: 'rsa.internal.device_ipv6', setter: fld_set},{field: 'related.ip', setter: fld_append}]},
    'device.type': {to:[{field: 'rsa.internal.device_type', setter: fld_set}]},
    'device.type.id': {convert: to_long, to:[{field: 'rsa.internal.device_type_id', setter: fld_set}]},
    'did': {to:[{field: 'rsa.internal.did', setter: fld_set}]},
    'directory.dst': {to:[{field: 'rsa.file.directory_dst', setter: fld_set}]},
    'directory.src': {to:[{field: 'rsa.file.directory_src', setter: fld_set}]},
    'ein.number': {convert: to_long, to:[{field: 'rsa.misc.ein_number', setter: fld_set}]},
    'entropy.req': {convert: to_long, to:[{field: 'rsa.internal.entropy_req', setter: fld_set}]},
    'entropy.res': {convert: to_long, to:[{field: 'rsa.internal.entropy_res', setter: fld_set}]},
    'eoc': {to:[{field: 'rsa.investigations.eoc', setter: fld_set}]},
    'event.cat': {convert: to_long, to:[{field: 'rsa.investigations.event_cat', setter: fld_prio, prio: 1}]},
    'event.cat.name': {to:[{field: 'rsa.investigations.event_cat_name', setter: fld_prio, prio: 1}]},
    'event_name': {to:[{field: 'rsa.internal.event_name', setter: fld_set}]},
    'expiration_time_string': {to:[{field: 'rsa.time.expire_time_str', setter: fld_set}]},
    'feed.category': {to:[{field: 'rsa.internal.feed_category', setter: fld_set}]},
    'file_entropy': {convert: to_double, to:[{field: 'rsa.file.file_entropy', setter: fld_set}]},
    'file_vendor': {to:[{field: 'rsa.file.file_vendor', setter: fld_set}]},
    'forward.ip': {convert: to_ip, to:[{field: 'rsa.internal.forward_ip', setter: fld_set},{field: 'related.ip', setter: fld_append}]},
    'forward.ipv6': {convert: to_ip, to:[{field: 'rsa.internal.forward_ipv6', setter: fld_set},{field: 'related.ip', setter: fld_append}]},
    'found': {to:[{field: 'rsa.misc.found', setter: fld_set}]},
    'header.id': {to:[{field: 'rsa.internal.header_id', setter: fld_set}]},
    'host.orig': {to:[{field: 'rsa.network.host_orig', setter: fld_set}]},
    'host_role': {to:[{field: 'rsa.identity.host_role', setter: fld_set}]},
    'host.state': {to:[{field: 'rsa.endpoint.host_state', setter: fld_set}]},
    'inv.category': {to:[{field: 'rsa.investigations.inv_category', setter: fld_set}]},
    'inv.context': {to:[{field: 'rsa.investigations.inv_context', setter: fld_set}]},
    'ioc': {to:[{field: 'rsa.investigations.ioc', setter: fld_set}]},
    'language': {to:[{field: 'rsa.misc.language', setter: fld_set}]},
    'lc.cid': {to:[{field: 'rsa.internal.lc_cid', setter: fld_set}]},
    'lc.ctime': {convert: to_date, to:[{field: 'rsa.internal.lc_ctime', setter: fld_set}]},
    'ldap': {to:[{field: 'rsa.identity.ldap', setter: fld_set}]},
    'ldap.query': {to:[{field: 'rsa.identity.ldap_query', setter: fld_set}]},
    'ldap.response': {to:[{field: 'rsa.identity.ldap_response', setter: fld_set}]},
    'lifetime': {convert: to_long, to:[{field: 'rsa.misc.lifetime', setter: fld_set}]},
    'link': {to:[{field: 'rsa.misc.link', setter: fld_set}]},
    'match': {to:[{field: 'rsa.misc.match', setter: fld_set}]},
    'mcb.req': {convert: to_long, to:[{field: 'rsa.internal.mcb_req', setter: fld_set}]},
    'mcb.res': {convert: to_long, to:[{field: 'rsa.internal.mcb_res', setter: fld_set}]},
    'mcbc.req': {convert: to_long, to:[{field: 'rsa.internal.mcbc_req', setter: fld_set}]},
    'mcbc.res': {convert: to_long, to:[{field: 'rsa.internal.mcbc_res', setter: fld_set}]},
    'medium': {convert: to_long, to:[{field: 'rsa.internal.medium', setter: fld_set}]},
    'nodename': {to:[{field: 'rsa.internal.node_name', setter: fld_set}]},
    'nwe.callback_id': {to:[{field: 'rsa.internal.nwe_callback_id', setter: fld_set}]},
    'org.dst': {to:[{field: 'rsa.physical.org_dst', setter: fld_prio, prio: 1}]},
    'org.src': {to:[{field: 'rsa.physical.org_src', setter: fld_set}]},
    'original_owner': {to:[{field: 'rsa.identity.owner', setter: fld_set}]},
    'param.dst': {to:[{field: 'rsa.misc.param_dst', setter: fld_set}]},
    'param.src': {to:[{field: 'rsa.misc.param_src', setter: fld_set}]},
    'parse.error': {to:[{field: 'rsa.internal.parse_error', setter: fld_set}]},
    'payload.req': {convert: to_long, to:[{field: 'rsa.internal.payload_req', setter: fld_set}]},
    'payload.res': {convert: to_long, to:[{field: 'rsa.internal.payload_res', setter: fld_set}]},
    'process.vid.dst': {to:[{field: 'rsa.internal.process_vid_dst', setter: fld_set}]},
    'process.vid.src': {to:[{field: 'rsa.internal.process_vid_src', setter: fld_set}]},
    'registry.key': {to:[{field: 'rsa.endpoint.registry_key', setter: fld_set}]},
    'registry.value': {to:[{field: 'rsa.endpoint.registry_value', setter: fld_set}]},
    'rid': {convert: to_long, to:[{field: 'rsa.internal.rid', setter: fld_set}]},
    'rpayload': {to:[{field: 'rsa.network.rpayload', setter: fld_set}]},
    'search.text': {to:[{field: 'rsa.misc.search_text', setter: fld_set}]},
    'service.account': {to:[{field: 'rsa.identity.service_account', setter: fld_set}]},
    'session.split': {to:[{field: 'rsa.internal.session_split', setter: fld_set}]},
    'sig.name': {to:[{field: 'rsa.misc.sig_name', setter: fld_set}]},
    'site': {to:[{field: 'rsa.internal.site', setter: fld_set}]},
    'size': {convert: to_long, to:[{field: 'rsa.internal.size', setter: fld_set}]},
    'snmp.value': {to:[{field: 'rsa.misc.snmp_value', setter: fld_set}]},
    'sourcefile': {to:[{field: 'rsa.internal.sourcefile', setter: fld_set}]},
    'stamp': {convert: to_date, to:[{field: 'rsa.time.stamp', setter: fld_set}]},
    'streams': {convert: to_long, to:[{field: 'rsa.misc.streams', setter: fld_set}]},
    'task_name': {to:[{field: 'rsa.file.task_name', setter: fld_set}]},
    'ubc.req': {convert: to_long, to:[{field: 'rsa.internal.ubc_req', setter: fld_set}]},
    'ubc.res': {convert: to_long, to:[{field: 'rsa.internal.ubc_res', setter: fld_set}]},
    'vlan.name': {to:[{field: 'rsa.network.vlan_name', setter: fld_set}]},
    'word': {to:[{field: 'rsa.internal.word', setter: fld_set}]},
}

function to_date(value) {
    switch (typeof (value)) {
        case "object":
            // This is a Date. But as it was obtained from evt.Get(), the VM
            // doesn't see it as a JS Date anymore, thus value instanceof Date === false.
            // Have to trust that any object here is a valid Date for Go.
            return value;
        case "string":
            var asDate = new Date(value);
            if (!isNaN(asDate)) return asDate;
    }
}

// ECMAScript 5.1 doesn't have Object.MAX_SAFE_INTEGER / Object.MIN_SAFE_INTEGER.
var maxSafeInt = Math.pow(2, 53) - 1;
var minSafeInt = -maxSafeInt;

function to_long(value) {
    var num = parseInt(value);
    // Better not to index a number if it's not safe (above 53 bits).
    return !isNaN(num) && minSafeInt <= num && num <= maxSafeInt ? num : undefined;
}

function to_ip(value) {
    if (value.indexOf(":") === -1)
        return to_ipv4(value);
    return to_ipv6(value);
}

var ipv4_regex = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
var ipv6_hex_regex = /^[0-9A-Fa-f]{1,4}$/;

function to_ipv4(value) {
    var result = ipv4_regex.exec(value);
    if (result == null || result.length !== 5) return;
    for (var i = 1; i < 5; i++) {
        var num = parseInt(result[i]);
        if (isNaN(num) || num < 0 || num > 255) return;
    }
    return value;
}

function to_ipv6(value) {
    var sqEnd = value.indexOf("]");
    if (sqEnd > -1) {
        if (value.charAt(0) !== '[') return;
        value = value.substr(1, sqEnd - 1);
    }
    var zoneOffset = value.indexOf('%');
    if (zoneOffset > -1) {
        value = value.substr(0, zoneOffset);
    }
    var parts = value.split(':');
    if (parts == null || parts.length < 3 || parts.length > 8) return;
    var numEmpty = 0;
    var innerEmpty = 0;
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].length === 0) {
            numEmpty++;
            if (i > 0 && i + 1 < parts.length) innerEmpty++;
        } else if (!parts[i].match(ipv6_hex_regex) &&
            // Accept an IPv6 with a valid IPv4 at the end.
            ((i + 1 < parts.length) || !to_ipv4(parts[i]))) {
            return
        }
    }
    return innerEmpty === 0 && parts.length === 8 || innerEmpty === 1 ? value : undefined;
}

function to_double(value) {
    return parseFloat(value);
}

function to_mac(value) {
    // ES doesn't have a mac datatype so it's safe to ingest whatever was captured.
    return value;
}

function to_lowercase(value) {
    // to_lowercase is used against keyword fields, which can accept
    // any other type (numbers, dates).
    return typeof(value) === 'string'? value.toLowerCase() : value;
}

function fld_set(dst, value) {
    dst[this.field] = { v: value }
}

function fld_append(dst, value) {
    if (dst[this.field] === undefined) {
        dst[this.field] = { v: [value] }
    } else {
        var base = dst[this.field];
        if (base.v.indexOf(value)===-1) base.v.push(value);
    }
}

function fld_prio(dst, value) {
    if (dst[this.field] === undefined) {
        dst[this.field] = { v: value, prio: this.prio}
    } else if(this.prio < dst[this.field].prio) {
        dst[this.field].v = value
        dst[this.field].prio = this.prio
    }
}

function map_all(evt, targets, value) {
    for (var i = 0; i < targets.length; i++) {
        evt.Put(targets[i], value);
    }
}

function populate_fields(evt) {
    var base = evt.Get(FIELDS_OBJECT);
    if (base === null) return;
    if (map_ecs) {
        do_populate(evt, base, ecs_mappings);
    }
    if (map_rsa) {
        do_populate(evt, base, rsa_mappings);
    }
    if (keep_raw) {
        evt.Put("rsa.raw", base);
    }
    evt.Delete(FIELDS_OBJECT);
}

function do_populate(evt, base, targets) {
    var result = {}
    for (var key in base) {
        if (!base.hasOwnProperty(key)) continue;
        var mapping = targets[key];
        if (mapping === undefined) continue;
        var value = base[key];
        if (mapping.convert !== undefined) {
            value = mapping.convert(value);
            if (value === undefined) {
                if (debug) {
                    console.debug("Failed to convert field '" + key + "' = '" + base[key] + "' with " + mapping.convert.name);
                }
                continue;
            }
        }
        for (var i=0; i<mapping.to.length; i++) {
            var tgt = mapping.to[i];
            tgt.setter(result, value);
        }
    }
    for (var key in result) {
        if (!result.hasOwnProperty(key)) continue;
        evt.Put(key, result[key].v);
    }
}

function test() {
    test_date_times();
    test_tz();
    test_conversions();
    test_mappings();
}

var pass_test = function (input, output) {
    return {input: input, expected: output !== undefined ? output : input}
}
var fail_test = function (input) {
    return {input: input}
}

function test_date_times() {
    var date_time = function(input) {
        var res = date_time_try_pattern(input.fmt, input.str, input.tz);
        return res !== undefined? res.toISOString() : res;
    }
    test_fn_call(date_time, [
        pass_test(
            {
                fmt: [dW,dc('-'),dM,dc('-'),dD,dc('T'),dH,dc(':'),dT,dc(':'),dS],
                str: "2017-10-16T15:23:42"
            },
            "2017-10-16T15:23:42.000Z"),
        pass_test(
            {
                fmt: [dR, dF, dc('th'), dY, dc(','), dI, dQ, dU, dc('min'), dO, dc('secs')],
                str: "October 7th 22, 3 P.M. 5 min 12 secs"
            },
            "2022-10-07T15:05:12.000Z"),
        pass_test(
            {
                fmt: [dF, dc('/'), dB, dY, dc(','), dI, dP],
                str: "31/OCT 70, 12am"
            },
            "1970-10-31T00:00:00.000Z"),
        pass_test(
            {
                fmt: [dX],
                str: "1592241213",
                tz: "+00:00"
            },
            "2020-06-15T17:13:33.000Z"),
        pass_test(
            {
                fmt: [dW, dG, dF, dZ],
                str: "20314 12 3:5:42",
                tz: "+02:00"
            }, "2031-04-12T01:05:42.000Z"),
        pass_test(
            {
                fmt: [dW, dG, dF, dZ],
                str: "20314 12 3:5:42",
                tz: "-07:30",
            }, "2031-04-12T10:35:42.000Z"),
        pass_test(
            {
                fmt: [dW, dG, dF, dZ],
                str: "20314 12 3:5:42",
                tz: "+0500",
            }, "2031-04-11T22:05:42.000Z")
    ]);
}

function test_tz() {
    test_fn_call(parse_local_tz_offset, [
        pass_test(0, "+00:00"),
        pass_test(59, "+00:59"),
        pass_test(60, "+01:00"),
        pass_test(61, "+01:01"),
        pass_test(-1, "-00:01"),
        pass_test(-59, "-00:59"),
        pass_test(-60, "-01:00"),
        pass_test(705, "+11:45"),
        pass_test(-705, "-11:45"),
    ]);
}

function test_conversions() {
    test_fn_call(to_ip, [
        pass_test("127.0.0.1"),
        pass_test("255.255.255.255"),
        pass_test("008.189.239.199"),
        fail_test(""),
        fail_test("not an IP"),
        fail_test("42"),
        fail_test("127.0.0.1."),
        fail_test("127.0.0."),
        fail_test("10.100.1000.1"),
        pass_test("fd00:1111:2222:3333:4444:5555:6666:7777"),
        pass_test("fd00::7777%eth0", "fd00::7777"),
        pass_test("[fd00::7777]", "fd00::7777"),
        pass_test("[fd00::7777%enp0s3]", "fd00::7777"),
        pass_test("::1"),
        pass_test("::"),
        fail_test(":::"),
        fail_test("fff::1::3"),
        pass_test("ffff::ffff"),
        fail_test("::1ffff"),
        fail_test(":1234:"),
        fail_test("::1234z"),
        pass_test("1::3:4:5:6:7:8"),
        pass_test("::255.255.255.255"),
        pass_test("64:ff9b::192.0.2.33"),
        fail_test("::255.255.255.255:8"),
    ]);
    test_fn_call(to_long, [
        pass_test("1234", 1234),
        pass_test("0x2a", 42),
        fail_test("9007199254740992"),
        fail_test("9223372036854775808"),
        fail_test("NaN"),
        pass_test("-0x1fffffffffffff", -9007199254740991),
        pass_test("+9007199254740991", 9007199254740991),
        fail_test("-0x20000000000000"),
        fail_test("+9007199254740992"),
        pass_test(42),
    ]);
    test_fn_call(to_date, [
        {
            input: new Date("2017-10-16T08:30:42Z"),
            expected: "2017-10-16T08:30:42.000Z",
            convert: Date.prototype.toISOString,
        },
        {
            input: "2017-10-16T08:30:42Z",
            expected: new Date("2017-10-16T08:30:42Z").toISOString(),
            convert: Date.prototype.toISOString,
        },
        fail_test("Not really a date."),
    ]);
    test_fn_call(to_lowercase, [
        pass_test("Hello", "hello"),
        pass_test(45),
        pass_test(Date.now()),
    ]);
}

function test_fn_call(fn, cases) {
    cases.forEach(function (test, idx) {
        var result = fn(test.input);
        if (test.convert !== undefined) {
            result = test.convert.call(result);
        }
        if (result !== test.expected) {
            throw "test " + fn.name + "#" + idx + " failed. Input:'" + JSON.stringify(test.input) + "' Expected:'" + test.expected + "' Got:'" + result + "'";
        }
    });
    if (debug) console.warn("test " + fn.name + " PASS.");
}

function test_mappings() {
    var test_mappings = {
        'a': {to: [{field: 'raw.a', setter: fld_set}, {field: 'list', setter: fld_append}]},
        'b': {to: [{field: 'list', setter: fld_append}]},
        'c': {to: [{field: 'raw.c', setter: fld_set}, {field: 'list', setter: fld_append}]},
        'd': {to: [{field: 'unique', setter: fld_prio, prio: 2}]},
        'e': {to: [{field: 'unique', setter: fld_prio, prio: 1}]},
        'f': {to: [{field: 'unique', setter: fld_prio, prio: 3}]}
    }
    var values = {
        'a': 'value1',
        'b': 'value2',
        'c': 'value1',
        'd': 'value3',
        'e': 'value4',
        'f': 'value5'
    }
    var expected = {
        'raw.a': 'value1',
        'raw.c': 'value1',
        'list': ['value1', 'value2'],
        'unique': 'value4'
    };
    var evt = new Event({});
    do_populate(evt, values, test_mappings);
    for (var key in expected) {
        var got = JSON.stringify(evt.Get(key));
        var exp = JSON.stringify(expected[key]);
        if (got !== exp) {
            throw "test test_mappings failed for key " + key
                + ". Expected:" + exp
                + " Got:" + got;
        }
    }
}
