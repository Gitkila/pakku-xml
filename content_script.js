const TRAD_DANMU_URL_RE = /(.+):\/\/comment\.bilibili\.com\/(?:rc\/)?(?:dmroll,[\d\-]+,)?(\d+)(?:\.xml)?$/;
const NEW_DANMU_NORMAL_URL_RE = /(.+):\/\/api\.bilibili\.com\/x\/v1\/dm\/list\.so\?oid=(\d+)$/;
const PROTO_DANMU_VIEW_URL_RE = /(.+):\/\/api\.bilibili\.com\/x\/v2\/dm\/(?:wbi\/)?(?:web|h5)\/view\?.*?oid=(\d+)&pid=(\d+).*?$/;
const PROTO_DANMU_SEG_URL_RE = /(.+):\/\/api\.bilibili\.com\/x\/v2\/dm\/(?:wbi\/)?(?:web|h5)\/seg\.so\?.*?oid=(\d+)&pid=(\d+).*?$/;
const PROTO_DANMU_HISTORY_URL_RE = /(.+):\/\/api\.bilibili\.com\/x\/v2\/dm\/web\/history\/seg\.so\?type=\d+&oid=(\d+)&date=([\d\-]+)$/;
class DanmuUrlFinder {
    protoapi_img_url = null;
    protoapi_sub_url = null;
    _cid_to_pid = {};
    find(url) {
        if (url.includes('//comment.bilibili.com/')) {
            let res = TRAD_DANMU_URL_RE.exec(url);
            if (res)
                return [{
                        type: 'xml',
                        url: url,
                    }, {
                        type: 'xml',
                        wait_finished: true,
                    }];
        }
        else if (url.includes('/list.so?')) {
            let res = NEW_DANMU_NORMAL_URL_RE.exec(url);
            if (res)
                return [{
                        type: 'xml',
                        url: url,
                    }, {
                        type: 'xml',
                        wait_finished: true,
                    }];
        }
        else if (url.includes('/history/seg.so?')) {
            let res = PROTO_DANMU_HISTORY_URL_RE.exec(url);
            if (res) {
                let date = res[3];
                if (date.startsWith('197')) // magic reload use timestamp near 0
                    return [{
                            type: 'proto_seg',
                            is_magicreload: true,
                            cid: res[2],
                            pid: this._cid_to_pid[res[2]] || '0',
                            static_img_url: this.protoapi_img_url,
                            static_sub_url: this.protoapi_sub_url,
                        }, {
                            type: 'proto_seg',
                            wait_finished: true,
                            segidx: null,
                            ps: null,
                            pe: null,
                        }];
                else // real history
                    return [{
                            type: 'proto_history',
                            url: url,
                        }, {
                            type: 'proto_seg',
                            wait_finished: true,
                            segidx: null,
                            ps: null,
                            pe: null,
                        }];
            }
        }
        else if (url.includes('/seg.so?')) {
            let res = PROTO_DANMU_SEG_URL_RE.exec(url);
            if (res) {
                this._cid_to_pid[res[2]] = res[3];
                let url_param = new URLSearchParams(url.split('?')[1] || '');
                let segidx = parseInt(url_param.get('segment_index') || '1');
                let ps_str = url_param.get('ps');
                let pe_str = url_param.get('pe');
                return [{
                        type: 'xml',
                        url: `https://comment.bilibili.com/${res[2]}.xml`,
                    }, {
                        type: 'proto_seg',
                        wait_finished: true,
                        segidx: segidx,
                        ps: ps_str ? parseInt(ps_str) : null,
                        pe: pe_str ? parseInt(pe_str) : null,
                    }];
            }
        }
        else if (url.includes('/view?')) {
            let res = PROTO_DANMU_VIEW_URL_RE.exec(url);
            if (res) {
                this._cid_to_pid[res[2]] = res[3];
                return [{
                        type: 'proto_seg',
                        is_magicreload: false,
                        cid: res[2],
                        pid: res[3],
                        static_img_url: this.protoapi_img_url,
                        static_sub_url: this.protoapi_sub_url,
                    }, {
                        type: 'proto_view',
                    }];
            }
        }
        return null;
    }
}
let url_finder = new DanmuUrlFinder();

const INIT_FUNCTION_NAME = 'prepare_combine';
const RUN_FUNCTION_NAME = 'do_combine';
const WORKER_FOOTER = `
onmessage = async (e) => {
    console.log('pakku worker: received job ' + e.data.cmd);
    try {
        let res = await self[e.data.cmd](...e.data.args);
        console.log('pakku worker: job done');
        postMessage({error: false, output: res});
    } catch(err) {
        console.error('pakku worker: job FAILED', err);
        postMessage({error: true, exc: err});
    }
};
`;
const WORKER_URL = chrome.runtime.getURL('/generated/combine_worker.js');
class WorkerMaker {
    use_simulated;
    worker_blob_url;
    simulated_module;
    constructor() {
        this.use_simulated = false;
        this.worker_blob_url = null;
        this.simulated_module = null;
    }
    async spawn() {
        if (this.use_simulated)
            return this._spawn_simulated();
        if (!this.worker_blob_url) {
            let src = await (await fetch(WORKER_URL)).text();
            // remove `export { ... };`
            src = src.replace(/\bexport\s*\{[\sa-zA-Z0-9_,]+}/, '');
            this.worker_blob_url = URL.createObjectURL(new Blob([src + WORKER_FOOTER], {
                type: "text/javascript",
            }));
        }
        try {
            return new Worker(this.worker_blob_url);
        }
        catch (e) {
            console.error('pakku worker pool: USE SIMULATED because web worker init failed', e);
            this.use_simulated = true;
            return await this._spawn_simulated();
        }
    }
    async _spawn_simulated() {
        if (!this.simulated_module) {
            this.simulated_module = await import(WORKER_URL);
        }
        let ret = {
            onmessage: null,
            postMessage: async (msg) => {
                console.log('pakku worker (simulated): received job', msg.cmd);
                try {
                    let res = await this.simulated_module[msg.cmd](...msg.args);
                    console.log('pakku worker (simulated): job done');
                    ret.onmessage({ data: { error: false, output: res } });
                }
                catch (err) {
                    console.error('pakku worker (simulated): job FAILED', err);
                    ret.onmessage({ data: { error: true, exc: err } });
                }
            },
            terminate: () => {
                // xxx: this WON'T actually free up memory used by the imported module
                // https://stackoverflow.com/questions/71684556/how-to-unload-dynamic-imports-in-javascript
                this.simulated_module = null;
            },
        };
        return ret;
    }
}
class WorkerPool {
    terminated;
    pool_size;
    workers;
    queue;
    constructor(pool_size) {
        this.terminated = false;
        this.pool_size = pool_size;
        this.workers = [];
        this.queue = [];
    }
    async spawn(init_args) {
        console.log('pakku worker pool: spawn', this.pool_size, 'workers');
        let maker = new WorkerMaker();
        if (this.pool_size === 0) {
            maker.use_simulated = true;
            this.pool_size = 1;
        }
        let spawn_single_worker = async () => {
            let w = await maker.spawn();
            let config = {
                worker: w,
                resolve: null,
                reject: null,
            };
            w.onmessage = (e) => {
                if (config.resolve && config.reject) {
                    if (e.data.error)
                        config.reject(e.data.exc);
                    else {
                        let output = e.data.output || null;
                        config.resolve(output);
                    }
                    config.resolve = null;
                    config.reject = null;
                }
                else {
                    console.error('pakku worker pool: BAD MESSAGE', e);
                }
                this._try_perform_work();
            };
            await new Promise((resolve, reject) => {
                config.resolve = resolve;
                config.reject = reject;
                w.postMessage({ cmd: INIT_FUNCTION_NAME, args: init_args });
            });
            return config;
        };
        this.workers = await Promise.all(new Array(this.pool_size).fill(0).map(spawn_single_worker));
    }
    _try_perform_work() {
        if (this.queue.length === 0)
            return;
        for (let w of this.workers) {
            if (w.resolve === null) { // idle
                let [msg, resolve, reject] = this.queue.shift();
                w.resolve = resolve;
                w.reject = reject;
                w.worker.postMessage(msg);
                return;
            }
        }
        //console.log('pakku worker pool: no idle workers, queue =', this.queue.length);
    }
    _exec(msg) {
        return new Promise((resolve, reject) => {
            if (this.terminated) {
                reject('worker pool: cannot accept job because terminated');
                return;
            }
            this.queue.push([msg, resolve, reject]);
            this._try_perform_work();
        });
    }
    async exec(args) {
        return await this._exec({ cmd: RUN_FUNCTION_NAME, args });
    }
    terminate() {
        if (!this.terminated) {
            this.terminated = true;
            console.log('pakku worker pool: terminated');
            for (let w of this.workers) {
                w.worker.terminate();
            }
        }
    }
}

// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session#browser_compatibility
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/StorageArea/setAccessLevel#browser_compatibility
let HAS_SESSION_STORAGE;
try {
    HAS_SESSION_STORAGE = !!(chrome?.storage?.session?.setAccessLevel);
}
catch (e) { // e.g. in web worker
    //console.error('pakku state: no session storage', e);
    HAS_SESSION_STORAGE = false;
}
async function save_state(state) {
    let store = HAS_SESSION_STORAGE ? chrome.storage.session : chrome.storage.local;
    await store.set(state);
}
async function remove_state(keys) {
    let store = HAS_SESSION_STORAGE ? chrome.storage.session : chrome.storage.local;
    await store.remove(keys);
}

const MissingData = Symbol('missing data');
class MessageStats {
    type;
    badge;
    message;
    constructor(type, badge, message) {
        this.type = type;
        this.badge = badge;
        this.message = message;
    }
    notify(tabid) {
        save_state({ ['STATS_' + tabid]: this })
            .then(() => {
            const BGCOLORS = { error: '#ff4444', message: '#4444ff' };
            void chrome.runtime.sendMessage({
                type: 'update_badge',
                tabid: tabid,
                text: this.badge,
                bgcolor: BGCOLORS[this.type],
            });
        });
        return this;
    }
}
class Stats {
    type = 'done';
    download_time_ms = 0;
    parse_time_ms = 0;
    userscript_time_ms = 0;
    combined_identical = 0;
    combined_edit_distance = 0;
    combined_pinyin_distance = 0;
    combined_cosine_distance = 0;
    deleted_dispval = 0;
    deleted_blacklist = 0;
    deleted_blacklist_each = {};
    ignored_whitelist = 0;
    ignored_script = 0;
    ignored_type = 0;
    modified_enlarge = 0;
    modified_shrink = 0;
    modified_scroll = 0;
    num_taolu_matched = 0;
    num_total_danmu = 0;
    num_onscreen_danmu = 0;
    num_max_combo = 0;
    num_max_dispval = 0;
    notify(tabid, config) {
        save_state({ ['STATS_' + tabid]: this })
            .then(() => {
            let text = (config.POPUP_BADGE === 'count' ? '' + (this.num_total_danmu - this.num_onscreen_danmu) :
                config.POPUP_BADGE === 'percent' ? `${this.num_total_danmu ? Math.max(0, 100 - 100 * this.num_onscreen_danmu / this.num_total_danmu).toFixed(0) : 0}%` :
                    config.POPUP_BADGE === 'dispval' ? '' + Math.ceil(this.num_max_dispval) :
                        /* off */ null);
            void chrome.runtime.sendMessage({
                type: 'update_badge',
                tabid: tabid,
                text: text,
                bgcolor: '#008800',
            });
        });
        return this;
    }
    update_from(x) {
        for (let k of [
            'combined_identical',
            'combined_edit_distance',
            'combined_pinyin_distance',
            'combined_cosine_distance',
            'deleted_dispval',
            'deleted_blacklist',
            'ignored_whitelist',
            'ignored_type',
            'ignored_script',
            'modified_enlarge',
            'modified_shrink',
            'modified_scroll',
            'num_taolu_matched',
        ]) {
            // @ts-ignore
            this[k] += x[k];
        }
        for (let k of [
            'num_max_combo',
            'num_max_dispval',
        ]) {
            // @ts-ignore
            this[k] = Math.max(this[k], x[k]);
        }
        for (let [k, v] of Object.entries(x.deleted_blacklist_each)) {
            this.deleted_blacklist_each[k] = (this.deleted_blacklist_each[k] || 0) + v;
        }
    }
}

// extracted from bilibiliPlayer.min.js
function parse_xml_magic(k) {
    try {
        k = k.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');
    }
    catch (c) { }
    return (new window.DOMParser).parseFromString(k, 'text/xml');
}
function xml_to_chunk(xmlstr) {
    let dom = parse_xml_magic(xmlstr);
    let res = [];
    let conf = {};
    let root_elem = dom.children[0];
    if (root_elem.tagName.toLowerCase() !== 'i')
        throw new Error('root_elem tagname is not i');
    for (let elem of root_elem.children) {
        if (elem.tagName.toLowerCase() === 'd') { // danmu
            let attr = elem.getAttribute('p').split(',');
            let str = elem.childNodes[0] ? elem.childNodes[0].data : '';
            res.push({
                "time_ms": Math.floor(parseFloat(attr[0]) * 1000),
                "mode": parseInt(attr[1]),
                "fontsize": parseFloat(attr[2]),
                "color": parseInt(attr[3]),
                "sender_hash": attr[6],
                "content": str,
                "sendtime": parseInt(attr[4]),
                "weight": 10, // not present in official xml api so fake max weight
                "id": attr[7],
                "pool": parseInt(attr[5]),
                "extra": {},
            });
        }
        else { // conf
            conf['xml_' + elem.tagName.toLowerCase()] = elem.childNodes[0].data;
        }
    }
    return {
        objs: res,
        extra: conf,
    };
}
function chunk_to_xml(chunk) {
    let parser = new DOMParser();
    let dom_str = ('<i>' +
        '<chatserver>chat.bilibili.com</chatserver>' +
        `<chatid>${chunk.extra.xml_chatid || 0}</chatid>` +
        '<mission>0</mission>' +
        `<maxlimit>${chunk.extra.xml_maxlimit || chunk.objs.length + 1}</maxlimit>` +
        '<state>0</state>' +
        '<real_name>0</real_name>' +
        '</i>');
    let dom = parser.parseFromString(dom_str, 'text/xml');
    let i_elem = dom.childNodes[0];
    for (let d of chunk.objs) {
        let elem = dom.createElement('d');
        let tn = dom.createTextNode(d.content);
        let attr = [
            d.time_ms / 1000, // 0
            d.mode, // 1
            d.fontsize, // 2
            d.color, // 3
            d.sendtime, // 4
            d.pool, // 5
            d.sender_hash, // 6
            d.id, // 7
            d.weight, // 8
        ];
        elem.appendChild(tn);
        elem.setAttribute('p', attr.join(','));
        i_elem.appendChild(elem);
    }
    let serializer = new XMLSerializer();
    let s = serializer.serializeToString(dom);
    // prettify
    return s.replace(/<d p=/g, '\n  <d p=').replace(/<\/i>/g, '\n</i>');
}
async function ingress_xml(ingress, chunk_callback) {
    let res = await fetch(ingress.url, { credentials: 'include' });
    let txt = await res.text();
    await chunk_callback(1, xml_to_chunk(txt));
}
async function ingress_xml_content(ingress, chunk_callback) {
    await chunk_callback(1, xml_to_chunk(ingress.content));
}
function egress_xml(egress, num_chunks, chunks) {
    if (!num_chunks || num_chunks !== chunks.size) {
        if (egress.wait_finished)
            return MissingData; // not finished
        else
            return chunk_to_xml({ objs: [], extra: {} });
    }
    let c = {
        objs: [],
        extra: chunks.get(1).extra,
    };
    for (let idx of [...chunks.keys()].sort((a, b) => a - b)) {
        c.objs.push(...chunks.get(idx).objs);
    }
    return chunk_to_xml(c);
}

var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

var protobuf_min = {exports: {}};

/*!
 * protobuf.js v7.4.0 (c) 2016, daniel wirtz
 * compiled thu, 22 aug 2024 20:30:39 utc
 * licensed under the bsd-3-clause license
 * see: https://github.com/dcodeio/protobuf.js for details
 */
protobuf_min.exports;

(function (module) {
	!function(d){!function(r,u,t){var n=function t(n){var i=u[n];return i||r[n][0].call(i=u[n]={exports:{}},t,i,i.exports),i.exports}(t[0]);n.util.global.protobuf=n,module&&module.exports&&(module.exports=n);}({1:[function(t,n,i){n.exports=function(t,n){var i=Array(arguments.length-1),e=0,r=2,s=!0;for(;r<arguments.length;)i[e++]=arguments[r++];return new Promise(function(r,u){i[e]=function(t){if(s)if(s=!1,t)u(t);else {for(var n=Array(arguments.length-1),i=0;i<n.length;)n[i++]=arguments[i];r.apply(null,n);}};try{t.apply(n||null,i);}catch(t){s&&(s=!1,u(t));}})};},{}],2:[function(t,n,i){i.length=function(t){var n=t.length;if(!n)return 0;for(var i=0;1<--n%4&&"="==(t[0|n]||"");)++i;return Math.ceil(3*t.length)/4-i};for(var f=Array(64),o=Array(123),r=0;r<64;)o[f[r]=r<26?r+65:r<52?r+71:r<62?r-4:r-59|43]=r++;i.encode=function(t,n,i){for(var r,u=null,e=[],s=0,h=0;n<i;){var o=t[n++];switch(h){case 0:e[s++]=f[o>>2],r=(3&o)<<4,h=1;break;case 1:e[s++]=f[r|o>>4],r=(15&o)<<2,h=2;break;case 2:e[s++]=f[r|o>>6],e[s++]=f[63&o],h=0;}8191<s&&((u=u||[]).push(String.fromCharCode.apply(String,e)),s=0);}return h&&(e[s++]=f[r],e[s++]=61,1===h&&(e[s++]=61)),u?(s&&u.push(String.fromCharCode.apply(String,e.slice(0,s))),u.join("")):String.fromCharCode.apply(String,e.slice(0,s))};var c="invalid encoding";i.decode=function(t,n,i){for(var r,u=i,e=0,s=0;s<t.length;){var h=t.charCodeAt(s++);if(61==h&&1<e)break;if((h=o[h])===d)throw Error(c);switch(e){case 0:r=h,e=1;break;case 1:n[i++]=r<<2|(48&h)>>4,r=h,e=2;break;case 2:n[i++]=(15&r)<<4|(60&h)>>2,r=h,e=3;break;case 3:n[i++]=(3&r)<<6|h,e=0;}}if(1===e)throw Error(c);return i-u},i.test=function(t){return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(t)};},{}],3:[function(t,n,i){function r(){this.t={};}(n.exports=r).prototype.on=function(t,n,i){return (this.t[t]||(this.t[t]=[])).push({fn:n,ctx:i||this}),this},r.prototype.off=function(t,n){if(t===d)this.t={};else if(n===d)this.t[t]=[];else for(var i=this.t[t],r=0;r<i.length;)i[r].fn===n?i.splice(r,1):++r;return this},r.prototype.emit=function(t){var n=this.t[t];if(n){for(var i=[],r=1;r<arguments.length;)i.push(arguments[r++]);for(r=0;r<n.length;)n[r].fn.apply(n[r++].ctx,i);}return this};},{}],4:[function(t,n,i){function r(t){function n(t,n,i,r){var u=n<0?1:0;t(0===(n=u?-n:n)?0<1/n?0:2147483648:isNaN(n)?2143289344:34028234663852886e22<n?(u<<31|2139095040)>>>0:n<11754943508222875e-54?(u<<31|Math.round(n/1401298464324817e-60))>>>0:(u<<31|127+(t=Math.floor(Math.log(n)/Math.LN2))<<23|8388607&Math.round(n*Math.pow(2,-t)*8388608))>>>0,i,r);}function i(t,n,i){t=t(n,i),n=2*(t>>31)+1,i=t>>>23&255,t&=8388607;return 255==i?t?NaN:1/0*n:0==i?1401298464324817e-60*n*t:n*Math.pow(2,i-150)*(8388608+t)}function r(t,n,i){h[0]=t,n[i]=o[0],n[i+1]=o[1],n[i+2]=o[2],n[i+3]=o[3];}function u(t,n,i){h[0]=t,n[i]=o[3],n[i+1]=o[2],n[i+2]=o[1],n[i+3]=o[0];}function e(t,n){return o[0]=t[n],o[1]=t[n+1],o[2]=t[n+2],o[3]=t[n+3],h[0]}function s(t,n){return o[3]=t[n],o[2]=t[n+1],o[1]=t[n+2],o[0]=t[n+3],h[0]}var h,o,f,c,a;function l(t,n,i,r,u,e){var s,h=r<0?1:0;0===(r=h?-r:r)?(t(0,u,e+n),t(0<1/r?0:2147483648,u,e+i)):isNaN(r)?(t(0,u,e+n),t(2146959360,u,e+i)):17976931348623157e292<r?(t(0,u,e+n),t((h<<31|2146435072)>>>0,u,e+i)):r<22250738585072014e-324?(t((s=r/5e-324)>>>0,u,e+n),t((h<<31|s/4294967296)>>>0,u,e+i)):(t(4503599627370496*(s=r*Math.pow(2,-(r=1024===(r=Math.floor(Math.log(r)/Math.LN2))?1023:r)))>>>0,u,e+n),t((h<<31|r+1023<<20|1048576*s&1048575)>>>0,u,e+i));}function v(t,n,i,r,u){n=t(r,u+n),t=t(r,u+i),r=2*(t>>31)+1,u=t>>>20&2047,i=4294967296*(1048575&t)+n;return 2047==u?i?NaN:1/0*r:0==u?5e-324*r*i:r*Math.pow(2,u-1075)*(i+4503599627370496)}function w(t,n,i){f[0]=t,n[i]=c[0],n[i+1]=c[1],n[i+2]=c[2],n[i+3]=c[3],n[i+4]=c[4],n[i+5]=c[5],n[i+6]=c[6],n[i+7]=c[7];}function b(t,n,i){f[0]=t,n[i]=c[7],n[i+1]=c[6],n[i+2]=c[5],n[i+3]=c[4],n[i+4]=c[3],n[i+5]=c[2],n[i+6]=c[1],n[i+7]=c[0];}function y(t,n){return c[0]=t[n],c[1]=t[n+1],c[2]=t[n+2],c[3]=t[n+3],c[4]=t[n+4],c[5]=t[n+5],c[6]=t[n+6],c[7]=t[n+7],f[0]}function g(t,n){return c[7]=t[n],c[6]=t[n+1],c[5]=t[n+2],c[4]=t[n+3],c[3]=t[n+4],c[2]=t[n+5],c[1]=t[n+6],c[0]=t[n+7],f[0]}return "undefined"!=typeof Float32Array?(h=new Float32Array([-0]),o=new Uint8Array(h.buffer),a=128===o[3],t.writeFloatLE=a?r:u,t.writeFloatBE=a?u:r,t.readFloatLE=a?e:s,t.readFloatBE=a?s:e):(t.writeFloatLE=n.bind(null,d),t.writeFloatBE=n.bind(null,A),t.readFloatLE=i.bind(null,p),t.readFloatBE=i.bind(null,m)),"undefined"!=typeof Float64Array?(f=new Float64Array([-0]),c=new Uint8Array(f.buffer),a=128===c[7],t.writeDoubleLE=a?w:b,t.writeDoubleBE=a?b:w,t.readDoubleLE=a?y:g,t.readDoubleBE=a?g:y):(t.writeDoubleLE=l.bind(null,d,0,4),t.writeDoubleBE=l.bind(null,A,4,0),t.readDoubleLE=v.bind(null,p,0,4),t.readDoubleBE=v.bind(null,m,4,0)),t}function d(t,n,i){n[i]=255&t,n[i+1]=t>>>8&255,n[i+2]=t>>>16&255,n[i+3]=t>>>24;}function A(t,n,i){n[i]=t>>>24,n[i+1]=t>>>16&255,n[i+2]=t>>>8&255,n[i+3]=255&t;}function p(t,n){return (t[n]|t[n+1]<<8|t[n+2]<<16|t[n+3]<<24)>>>0}function m(t,n){return (t[n]<<24|t[n+1]<<16|t[n+2]<<8|t[n+3])>>>0}n.exports=r(r);},{}],5:[function(t,n,i){function r(t){try{var n=undefined("require")(t);if(n&&(n.length||Object.keys(n).length))return n}catch(t){}return null}n.exports=r;},{}],6:[function(t,n,i){n.exports=function(n,i,t){var r=t||8192,u=r>>>1,e=null,s=r;return function(t){if(t<1||u<t)return n(t);r<s+t&&(e=n(r),s=0);t=i.call(e,s,s+=t);return 7&s&&(s=1+(7|s)),t}};},{}],7:[function(t,n,i){i.length=function(t){for(var n,i=0,r=0;r<t.length;++r)(n=t.charCodeAt(r))<128?i+=1:n<2048?i+=2:55296==(64512&n)&&56320==(64512&t.charCodeAt(r+1))?(++r,i+=4):i+=3;return i},i.read=function(t,n,i){if(i-n<1)return "";for(var r,u=null,e=[],s=0;n<i;)(r=t[n++])<128?e[s++]=r:191<r&&r<224?e[s++]=(31&r)<<6|63&t[n++]:239<r&&r<365?(r=((7&r)<<18|(63&t[n++])<<12|(63&t[n++])<<6|63&t[n++])-65536,e[s++]=55296+(r>>10),e[s++]=56320+(1023&r)):e[s++]=(15&r)<<12|(63&t[n++])<<6|63&t[n++],8191<s&&((u=u||[]).push(String.fromCharCode.apply(String,e)),s=0);return u?(s&&u.push(String.fromCharCode.apply(String,e.slice(0,s))),u.join("")):String.fromCharCode.apply(String,e.slice(0,s))},i.write=function(t,n,i){for(var r,u,e=i,s=0;s<t.length;++s)(r=t.charCodeAt(s))<128?n[i++]=r:(r<2048?n[i++]=r>>6|192:(55296==(64512&r)&&56320==(64512&(u=t.charCodeAt(s+1)))?(++s,n[i++]=(r=65536+((1023&r)<<10)+(1023&u))>>18|240,n[i++]=r>>12&63|128):n[i++]=r>>12|224,n[i++]=r>>6&63|128),n[i++]=63&r|128);return i-e};},{}],8:[function(t,n,i){var r=i;function u(){r.util.n(),r.Writer.n(r.BufferWriter),r.Reader.n(r.BufferReader);}r.build="minimal",r.Writer=t(16),r.BufferWriter=t(17),r.Reader=t(9),r.BufferReader=t(10),r.util=t(15),r.rpc=t(12),r.roots=t(11),r.configure=u,u();},{10:10,11:11,12:12,15:15,16:16,17:17,9:9}],9:[function(t,n,i){n.exports=o;var r,u=t(15),e=u.LongBits,s=u.utf8;function h(t,n){return RangeError("index out of range: "+t.pos+" + "+(n||1)+" > "+t.len)}function o(t){this.buf=t,this.pos=0,this.len=t.length;}function f(){return u.Buffer?function(t){return (o.create=function(t){return u.Buffer.isBuffer(t)?new r(t):a(t)})(t)}:a}var c,a="undefined"!=typeof Uint8Array?function(t){if(t instanceof Uint8Array||Array.isArray(t))return new o(t);throw Error("illegal buffer")}:function(t){if(Array.isArray(t))return new o(t);throw Error("illegal buffer")};function l(){var t=new e(0,0),n=0;if(!(4<this.len-this.pos)){for(;n<3;++n){if(this.pos>=this.len)throw h(this);if(t.lo=(t.lo|(127&this.buf[this.pos])<<7*n)>>>0,this.buf[this.pos++]<128)return t}return t.lo=(t.lo|(127&this.buf[this.pos++])<<7*n)>>>0,t}for(;n<4;++n)if(t.lo=(t.lo|(127&this.buf[this.pos])<<7*n)>>>0,this.buf[this.pos++]<128)return t;if(t.lo=(t.lo|(127&this.buf[this.pos])<<28)>>>0,t.hi=(t.hi|(127&this.buf[this.pos])>>4)>>>0,this.buf[this.pos++]<128)return t;if(n=0,4<this.len-this.pos){for(;n<5;++n)if(t.hi=(t.hi|(127&this.buf[this.pos])<<7*n+3)>>>0,this.buf[this.pos++]<128)return t}else for(;n<5;++n){if(this.pos>=this.len)throw h(this);if(t.hi=(t.hi|(127&this.buf[this.pos])<<7*n+3)>>>0,this.buf[this.pos++]<128)return t}throw Error("invalid varint encoding")}function v(t,n){return (t[n-4]|t[n-3]<<8|t[n-2]<<16|t[n-1]<<24)>>>0}function w(){if(this.pos+8>this.len)throw h(this,8);return new e(v(this.buf,this.pos+=4),v(this.buf,this.pos+=4))}o.create=f(),o.prototype.i=u.Array.prototype.subarray||u.Array.prototype.slice,o.prototype.uint32=(c=4294967295,function(){if(c=(127&this.buf[this.pos])>>>0,this.buf[this.pos++]<128||(c=(c|(127&this.buf[this.pos])<<7)>>>0,this.buf[this.pos++]<128||(c=(c|(127&this.buf[this.pos])<<14)>>>0,this.buf[this.pos++]<128||(c=(c|(127&this.buf[this.pos])<<21)>>>0,this.buf[this.pos++]<128||(c=(c|(15&this.buf[this.pos])<<28)>>>0,this.buf[this.pos++]<128||!((this.pos+=5)>this.len))))))return c;throw this.pos=this.len,h(this,10)}),o.prototype.int32=function(){return 0|this.uint32()},o.prototype.sint32=function(){var t=this.uint32();return t>>>1^-(1&t)|0},o.prototype.bool=function(){return 0!==this.uint32()},o.prototype.fixed32=function(){if(this.pos+4>this.len)throw h(this,4);return v(this.buf,this.pos+=4)},o.prototype.sfixed32=function(){if(this.pos+4>this.len)throw h(this,4);return 0|v(this.buf,this.pos+=4)},o.prototype.float=function(){if(this.pos+4>this.len)throw h(this,4);var t=u.float.readFloatLE(this.buf,this.pos);return this.pos+=4,t},o.prototype.double=function(){if(this.pos+8>this.len)throw h(this,4);var t=u.float.readDoubleLE(this.buf,this.pos);return this.pos+=8,t},o.prototype.bytes=function(){var t=this.uint32(),n=this.pos,i=this.pos+t;if(i>this.len)throw h(this,t);return this.pos+=t,Array.isArray(this.buf)?this.buf.slice(n,i):n===i?(t=u.Buffer)?t.alloc(0):new this.buf.constructor(0):this.i.call(this.buf,n,i)},o.prototype.string=function(){var t=this.bytes();return s.read(t,0,t.length)},o.prototype.skip=function(t){if("number"==typeof t){if(this.pos+t>this.len)throw h(this,t);this.pos+=t;}else do{if(this.pos>=this.len)throw h(this)}while(128&this.buf[this.pos++]);return this},o.prototype.skipType=function(t){switch(t){case 0:this.skip();break;case 1:this.skip(8);break;case 2:this.skip(this.uint32());break;case 3:for(;4!=(t=7&this.uint32());)this.skipType(t);break;case 5:this.skip(4);break;default:throw Error("invalid wire type "+t+" at offset "+this.pos)}return this},o.n=function(t){r=t,o.create=f(),r.n();var n=u.Long?"toLong":"toNumber";u.merge(o.prototype,{int64:function(){return l.call(this)[n](!1)},uint64:function(){return l.call(this)[n](!0)},sint64:function(){return l.call(this).zzDecode()[n](!1)},fixed64:function(){return w.call(this)[n](!0)},sfixed64:function(){return w.call(this)[n](!1)}});};},{15:15}],10:[function(t,n,i){n.exports=e;var r=t(9),u=((e.prototype=Object.create(r.prototype)).constructor=e,t(15));function e(t){r.call(this,t);}e.n=function(){u.Buffer&&(e.prototype.i=u.Buffer.prototype.slice);},e.prototype.string=function(){var t=this.uint32();return this.buf.utf8Slice?this.buf.utf8Slice(this.pos,this.pos=Math.min(this.pos+t,this.len)):this.buf.toString("utf-8",this.pos,this.pos=Math.min(this.pos+t,this.len))},e.n();},{15:15,9:9}],11:[function(t,n,i){n.exports={};},{}],12:[function(t,n,i){i.Service=t(13);},{13:13}],13:[function(t,n,i){n.exports=r;var h=t(15);function r(t,n,i){if("function"!=typeof t)throw TypeError("rpcImpl must be a function");h.EventEmitter.call(this),this.rpcImpl=t,this.requestDelimited=!!n,this.responseDelimited=!!i;}((r.prototype=Object.create(h.EventEmitter.prototype)).constructor=r).prototype.rpcCall=function t(i,n,r,u,e){if(!u)throw TypeError("request must be specified");var s=this;if(!e)return h.asPromise(t,s,i,n,r,u);if(!s.rpcImpl)return setTimeout(function(){e(Error("already ended"));},0),d;try{return s.rpcImpl(i,n[s.requestDelimited?"encodeDelimited":"encode"](u).finish(),function(t,n){if(t)return s.emit("error",t,i),e(t);if(null===n)return s.end(!0),d;if(!(n instanceof r))try{n=r[s.responseDelimited?"decodeDelimited":"decode"](n);}catch(t){return s.emit("error",t,i),e(t)}return s.emit("data",n,i),e(null,n)})}catch(t){return s.emit("error",t,i),setTimeout(function(){e(t);},0),d}},r.prototype.end=function(t){return this.rpcImpl&&(t||this.rpcImpl(null,null,null),this.rpcImpl=null,this.emit("end").off()),this};},{15:15}],14:[function(t,n,i){n.exports=u;var r=t(15);function u(t,n){this.lo=t>>>0,this.hi=n>>>0;}var e=u.zero=new u(0,0),s=(e.toNumber=function(){return 0},e.zzEncode=e.zzDecode=function(){return this},e.length=function(){return 1},u.zeroHash="\0\0\0\0\0\0\0\0",u.fromNumber=function(t){var n,i;return 0===t?e:(i=(t=(n=t<0)?-t:t)>>>0,t=(t-i)/4294967296>>>0,n&&(t=~t>>>0,i=~i>>>0,4294967295<++i&&(i=0,4294967295<++t&&(t=0))),new u(i,t))},u.from=function(t){if("number"==typeof t)return u.fromNumber(t);if(r.isString(t)){if(!r.Long)return u.fromNumber(parseInt(t,10));t=r.Long.fromString(t);}return t.low||t.high?new u(t.low>>>0,t.high>>>0):e},u.prototype.toNumber=function(t){var n;return !t&&this.hi>>>31?(t=1+~this.lo>>>0,n=~this.hi>>>0,-(t+4294967296*(n=t?n:n+1>>>0))):this.lo+4294967296*this.hi},u.prototype.toLong=function(t){return r.Long?new r.Long(0|this.lo,0|this.hi,!!t):{low:0|this.lo,high:0|this.hi,unsigned:!!t}},String.prototype.charCodeAt);u.fromHash=function(t){return "\0\0\0\0\0\0\0\0"===t?e:new u((s.call(t,0)|s.call(t,1)<<8|s.call(t,2)<<16|s.call(t,3)<<24)>>>0,(s.call(t,4)|s.call(t,5)<<8|s.call(t,6)<<16|s.call(t,7)<<24)>>>0)},u.prototype.toHash=function(){return String.fromCharCode(255&this.lo,this.lo>>>8&255,this.lo>>>16&255,this.lo>>>24,255&this.hi,this.hi>>>8&255,this.hi>>>16&255,this.hi>>>24)},u.prototype.zzEncode=function(){var t=this.hi>>31;return this.hi=((this.hi<<1|this.lo>>>31)^t)>>>0,this.lo=(this.lo<<1^t)>>>0,this},u.prototype.zzDecode=function(){var t=-(1&this.lo);return this.lo=((this.lo>>>1|this.hi<<31)^t)>>>0,this.hi=(this.hi>>>1^t)>>>0,this},u.prototype.length=function(){var t=this.lo,n=(this.lo>>>28|this.hi<<4)>>>0,i=this.hi>>>24;return 0==i?0==n?t<16384?t<128?1:2:t<2097152?3:4:n<16384?n<128?5:6:n<2097152?7:8:i<128?9:10};},{15:15}],15:[function(t,n,i){var r=i;function u(t,n,i){for(var r=Object.keys(n),u=0;u<r.length;++u)t[r[u]]!==d&&i||(t[r[u]]=n[r[u]]);return t}function e(t){function i(t,n){if(!(this instanceof i))return new i(t,n);Object.defineProperty(this,"message",{get:function(){return t}}),Error.captureStackTrace?Error.captureStackTrace(this,i):Object.defineProperty(this,"stack",{value:Error().stack||""}),n&&u(this,n);}return i.prototype=Object.create(Error.prototype,{constructor:{value:i,writable:!0,enumerable:!1,configurable:!0},name:{get:function(){return t},set:d,enumerable:!1,configurable:!0},toString:{value:function(){return this.name+": "+this.message},writable:!0,enumerable:!1,configurable:!0}}),i}r.asPromise=t(1),r.base64=t(2),r.EventEmitter=t(3),r.float=t(4),r.inquire=t(5),r.utf8=t(7),r.pool=t(6),r.LongBits=t(14),r.isNode=!!("undefined"!=typeof commonjsGlobal&&commonjsGlobal&&commonjsGlobal.process&&commonjsGlobal.process.versions&&commonjsGlobal.process.versions.node),r.global=r.isNode&&commonjsGlobal||"undefined"!=typeof window&&window||"undefined"!=typeof self&&self||this,r.emptyArray=Object.freeze?Object.freeze([]):[],r.emptyObject=Object.freeze?Object.freeze({}):{},r.isInteger=Number.isInteger||function(t){return "number"==typeof t&&isFinite(t)&&Math.floor(t)===t},r.isString=function(t){return "string"==typeof t||t instanceof String},r.isObject=function(t){return t&&"object"==typeof t},r.isset=r.isSet=function(t,n){var i=t[n];return null!=i&&t.hasOwnProperty(n)&&("object"!=typeof i||0<(Array.isArray(i)?i:Object.keys(i)).length)},r.Buffer=function(){try{var t=r.inquire("buffer").Buffer;return t.prototype.utf8Write?t:null}catch(t){return null}}(),r.r=null,r.u=null,r.newBuffer=function(t){return "number"==typeof t?r.Buffer?r.u(t):new r.Array(t):r.Buffer?r.r(t):"undefined"==typeof Uint8Array?t:new Uint8Array(t)},r.Array="undefined"!=typeof Uint8Array?Uint8Array:Array,r.Long=r.global.dcodeIO&&r.global.dcodeIO.Long||r.global.Long||r.inquire("long"),r.key2Re=/^true|false|0|1$/,r.key32Re=/^-?(?:0|[1-9][0-9]*)$/,r.key64Re=/^(?:[\\x00-\\xff]{8}|-?(?:0|[1-9][0-9]*))$/,r.longToHash=function(t){return t?r.LongBits.from(t).toHash():r.LongBits.zeroHash},r.longFromHash=function(t,n){t=r.LongBits.fromHash(t);return r.Long?r.Long.fromBits(t.lo,t.hi,n):t.toNumber(!!n)},r.merge=u,r.lcFirst=function(t){return (t[0]||"").toLowerCase()+t.substring(1)},r.newError=e,r.ProtocolError=e("ProtocolError"),r.oneOfGetter=function(t){for(var i={},n=0;n<t.length;++n)i[t[n]]=1;return function(){for(var t=Object.keys(this),n=t.length-1;-1<n;--n)if(1===i[t[n]]&&this[t[n]]!==d&&null!==this[t[n]])return t[n]}},r.oneOfSetter=function(i){return function(t){for(var n=0;n<i.length;++n)i[n]!==t&&delete this[i[n]];}},r.toJSONOptions={longs:String,enums:String,bytes:String,json:!0},r.n=function(){var i=r.Buffer;i?(r.r=i.from!==Uint8Array.from&&i.from||function(t,n){return new i(t,n)},r.u=i.allocUnsafe||function(t){return new i(t)}):r.r=r.u=null;};},{1:1,14:14,2:2,3:3,4:4,5:5,6:6,7:7}],16:[function(t,n,i){n.exports=a;var r,u=t(15),e=u.LongBits,s=u.base64,h=u.utf8;function o(t,n,i){this.fn=t,this.len=n,this.next=d,this.val=i;}function f(){}function c(t){this.head=t.head,this.tail=t.tail,this.len=t.len,this.next=t.states;}function a(){this.len=0,this.head=new o(f,0,0),this.tail=this.head,this.states=null;}function l(){return u.Buffer?function(){return (a.create=function(){return new r})()}:function(){return new a}}function v(t,n,i){n[i]=255&t;}function w(t,n){this.len=t,this.next=d,this.val=n;}function b(t,n,i){for(;t.hi;)n[i++]=127&t.lo|128,t.lo=(t.lo>>>7|t.hi<<25)>>>0,t.hi>>>=7;for(;127<t.lo;)n[i++]=127&t.lo|128,t.lo=t.lo>>>7;n[i++]=t.lo;}function y(t,n,i){n[i]=255&t,n[i+1]=t>>>8&255,n[i+2]=t>>>16&255,n[i+3]=t>>>24;}a.create=l(),a.alloc=function(t){return new u.Array(t)},u.Array!==Array&&(a.alloc=u.pool(a.alloc,u.Array.prototype.subarray)),a.prototype.e=function(t,n,i){return this.tail=this.tail.next=new o(t,n,i),this.len+=n,this},(w.prototype=Object.create(o.prototype)).fn=function(t,n,i){for(;127<t;)n[i++]=127&t|128,t>>>=7;n[i]=t;},a.prototype.uint32=function(t){return this.len+=(this.tail=this.tail.next=new w((t>>>=0)<128?1:t<16384?2:t<2097152?3:t<268435456?4:5,t)).len,this},a.prototype.int32=function(t){return t<0?this.e(b,10,e.fromNumber(t)):this.uint32(t)},a.prototype.sint32=function(t){return this.uint32((t<<1^t>>31)>>>0)},a.prototype.int64=a.prototype.uint64=function(t){t=e.from(t);return this.e(b,t.length(),t)},a.prototype.sint64=function(t){t=e.from(t).zzEncode();return this.e(b,t.length(),t)},a.prototype.bool=function(t){return this.e(v,1,t?1:0)},a.prototype.sfixed32=a.prototype.fixed32=function(t){return this.e(y,4,t>>>0)},a.prototype.sfixed64=a.prototype.fixed64=function(t){t=e.from(t);return this.e(y,4,t.lo).e(y,4,t.hi)},a.prototype.float=function(t){return this.e(u.float.writeFloatLE,4,t)},a.prototype.double=function(t){return this.e(u.float.writeDoubleLE,8,t)};var g=u.Array.prototype.set?function(t,n,i){n.set(t,i);}:function(t,n,i){for(var r=0;r<t.length;++r)n[i+r]=t[r];};a.prototype.bytes=function(t){var n,i=t.length>>>0;return i?(u.isString(t)&&(n=a.alloc(i=s.length(t)),s.decode(t,n,0),t=n),this.uint32(i).e(g,i,t)):this.e(v,1,0)},a.prototype.string=function(t){var n=h.length(t);return n?this.uint32(n).e(h.write,n,t):this.e(v,1,0)},a.prototype.fork=function(){return this.states=new c(this),this.head=this.tail=new o(f,0,0),this.len=0,this},a.prototype.reset=function(){return this.states?(this.head=this.states.head,this.tail=this.states.tail,this.len=this.states.len,this.states=this.states.next):(this.head=this.tail=new o(f,0,0),this.len=0),this},a.prototype.ldelim=function(){var t=this.head,n=this.tail,i=this.len;return this.reset().uint32(i),i&&(this.tail.next=t.next,this.tail=n,this.len+=i),this},a.prototype.finish=function(){for(var t=this.head.next,n=this.constructor.alloc(this.len),i=0;t;)t.fn(t.val,n,i),i+=t.len,t=t.next;return n},a.n=function(t){r=t,a.create=l(),r.n();};},{15:15}],17:[function(t,n,i){n.exports=e;var r=t(16),u=((e.prototype=Object.create(r.prototype)).constructor=e,t(15));function e(){r.call(this);}function s(t,n,i){t.length<40?u.utf8.write(t,n,i):n.utf8Write?n.utf8Write(t,i):n.write(t,i);}e.n=function(){e.alloc=u.u,e.writeBytesBuffer=u.Buffer&&u.Buffer.prototype instanceof Uint8Array&&"set"===u.Buffer.prototype.set.name?function(t,n,i){n.set(t,i);}:function(t,n,i){if(t.copy)t.copy(n,i,0,t.length);else for(var r=0;r<t.length;)n[i++]=t[r++];};},e.prototype.bytes=function(t){var n=(t=u.isString(t)?u.r(t,"base64"):t).length>>>0;return this.uint32(n),n&&this.e(e.writeBytesBuffer,n,t),this},e.prototype.string=function(t){var n=u.Buffer.byteLength(t);return this.uint32(n),n&&this.e(s,n,t),this},e.n();},{15:15,16:16}]},{},[8]);}();
	
} (protobuf_min));

var protobuf_minExports = protobuf_min.exports;

/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars*/

// Common aliases
const $Reader = protobuf_minExports.Reader, $Writer = protobuf_minExports.Writer, $util = protobuf_minExports.util;

// Exported root namespace
const $root = protobuf_minExports.roots["default"] || (protobuf_minExports.roots["default"] = {});

$root.bilibili = (() => {

    /**
     * Namespace bilibili.
     * @exports bilibili
     * @namespace
     */
    const bilibili = {};

    bilibili.community = (function() {

        /**
         * Namespace community.
         * @memberof bilibili
         * @namespace
         */
        const community = {};

        community.service = (function() {

            /**
             * Namespace service.
             * @memberof bilibili.community
             * @namespace
             */
            const service = {};

            service.dm = (function() {

                /**
                 * Namespace dm.
                 * @memberof bilibili.community.service
                 * @namespace
                 */
                const dm = {};

                dm.v1 = (function() {

                    /**
                     * Namespace v1.
                     * @memberof bilibili.community.service.dm
                     * @namespace
                     */
                    const v1 = {};

                    v1.DmWebViewReply = (function() {

                        /**
                         * Properties of a DmWebViewReply.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IDmWebViewReply
                         * @property {number|null} [state] DmWebViewReply state
                         * @property {string|null} [text] DmWebViewReply text
                         * @property {string|null} [textSide] DmWebViewReply textSide
                         * @property {bilibili.community.service.dm.v1.IDmSegConfig|null} [dmSge] DmWebViewReply dmSge
                         * @property {bilibili.community.service.dm.v1.IDanmakuFlagConfig|null} [flag] DmWebViewReply flag
                         * @property {Array.<string>|null} [specialDms] DmWebViewReply specialDms
                         * @property {boolean|null} [checkBox] DmWebViewReply checkBox
                         * @property {number|null} [count] DmWebViewReply count
                         * @property {Array.<bilibili.community.service.dm.v1.ICommandDm>|null} [commandDms] DmWebViewReply commandDms
                         * @property {bilibili.community.service.dm.v1.IDanmuWebPlayerConfig|null} [dmSetting] DmWebViewReply dmSetting
                         * @property {Array.<string>|null} [reportFilter] DmWebViewReply reportFilter
                         * @property {Array.<bilibili.community.service.dm.v1.IExpressions>|null} [expressions] DmWebViewReply expressions
                         * @property {Array.<bilibili.community.service.dm.v1.IPostPanel>|null} [postPanel] DmWebViewReply postPanel
                         * @property {Array.<string>|null} [activityMetas] DmWebViewReply activityMetas
                         * @property {Array.<bilibili.community.service.dm.v1.IPostPanelV2>|null} [postPanelV2] DmWebViewReply postPanelV2
                         * @property {Array.<bilibili.community.service.dm.v1.IDmSubView>|null} [subViews] DmWebViewReply subViews
                         * @property {bilibili.community.service.dm.v1.IQoeInfo|null} [qoe] DmWebViewReply qoe
                         * @property {Array.<bilibili.community.service.dm.v1.IDmMaskWall>|null} [maskWalls] DmWebViewReply maskWalls
                         */

                        /**
                         * Constructs a new DmWebViewReply.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a DmWebViewReply.
                         * @implements IDmWebViewReply
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IDmWebViewReply=} [properties] Properties to set
                         */
                        function DmWebViewReply(properties) {
                            this.specialDms = [];
                            this.commandDms = [];
                            this.reportFilter = [];
                            this.expressions = [];
                            this.postPanel = [];
                            this.activityMetas = [];
                            this.postPanelV2 = [];
                            this.subViews = [];
                            this.maskWalls = [];
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * DmWebViewReply state.
                         * @member {number} state
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.state = 0;

                        /**
                         * DmWebViewReply text.
                         * @member {string} text
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.text = "";

                        /**
                         * DmWebViewReply textSide.
                         * @member {string} textSide
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.textSide = "";

                        /**
                         * DmWebViewReply dmSge.
                         * @member {bilibili.community.service.dm.v1.IDmSegConfig|null|undefined} dmSge
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.dmSge = null;

                        /**
                         * DmWebViewReply flag.
                         * @member {bilibili.community.service.dm.v1.IDanmakuFlagConfig|null|undefined} flag
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.flag = null;

                        /**
                         * DmWebViewReply specialDms.
                         * @member {Array.<string>} specialDms
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.specialDms = $util.emptyArray;

                        /**
                         * DmWebViewReply checkBox.
                         * @member {boolean} checkBox
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.checkBox = false;

                        /**
                         * DmWebViewReply count.
                         * @member {number} count
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.count = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * DmWebViewReply commandDms.
                         * @member {Array.<bilibili.community.service.dm.v1.ICommandDm>} commandDms
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.commandDms = $util.emptyArray;

                        /**
                         * DmWebViewReply dmSetting.
                         * @member {bilibili.community.service.dm.v1.IDanmuWebPlayerConfig|null|undefined} dmSetting
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.dmSetting = null;

                        /**
                         * DmWebViewReply reportFilter.
                         * @member {Array.<string>} reportFilter
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.reportFilter = $util.emptyArray;

                        /**
                         * DmWebViewReply expressions.
                         * @member {Array.<bilibili.community.service.dm.v1.IExpressions>} expressions
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.expressions = $util.emptyArray;

                        /**
                         * DmWebViewReply postPanel.
                         * @member {Array.<bilibili.community.service.dm.v1.IPostPanel>} postPanel
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.postPanel = $util.emptyArray;

                        /**
                         * DmWebViewReply activityMetas.
                         * @member {Array.<string>} activityMetas
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.activityMetas = $util.emptyArray;

                        /**
                         * DmWebViewReply postPanelV2.
                         * @member {Array.<bilibili.community.service.dm.v1.IPostPanelV2>} postPanelV2
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.postPanelV2 = $util.emptyArray;

                        /**
                         * DmWebViewReply subViews.
                         * @member {Array.<bilibili.community.service.dm.v1.IDmSubView>} subViews
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.subViews = $util.emptyArray;

                        /**
                         * DmWebViewReply qoe.
                         * @member {bilibili.community.service.dm.v1.IQoeInfo|null|undefined} qoe
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.qoe = null;

                        /**
                         * DmWebViewReply maskWalls.
                         * @member {Array.<bilibili.community.service.dm.v1.IDmMaskWall>} maskWalls
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @instance
                         */
                        DmWebViewReply.prototype.maskWalls = $util.emptyArray;

                        /**
                         * Encodes the specified DmWebViewReply message. Does not implicitly {@link bilibili.community.service.dm.v1.DmWebViewReply.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @static
                         * @param {bilibili.community.service.dm.v1.IDmWebViewReply} message DmWebViewReply message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        DmWebViewReply.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.state != null && Object.hasOwnProperty.call(message, "state"))
                                writer.uint32(/* id 1, wireType 0 =*/8).int32(message.state);
                            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                                writer.uint32(/* id 2, wireType 2 =*/18).string(message.text);
                            if (message.textSide != null && Object.hasOwnProperty.call(message, "textSide"))
                                writer.uint32(/* id 3, wireType 2 =*/26).string(message.textSide);
                            if (message.dmSge != null && Object.hasOwnProperty.call(message, "dmSge"))
                                $root.bilibili.community.service.dm.v1.DmSegConfig.encode(message.dmSge, writer.uint32(/* id 4, wireType 2 =*/34).fork()).ldelim();
                            if (message.flag != null && Object.hasOwnProperty.call(message, "flag"))
                                $root.bilibili.community.service.dm.v1.DanmakuFlagConfig.encode(message.flag, writer.uint32(/* id 5, wireType 2 =*/42).fork()).ldelim();
                            if (message.specialDms != null && message.specialDms.length)
                                for (let i = 0; i < message.specialDms.length; ++i)
                                    writer.uint32(/* id 6, wireType 2 =*/50).string(message.specialDms[i]);
                            if (message.checkBox != null && Object.hasOwnProperty.call(message, "checkBox"))
                                writer.uint32(/* id 7, wireType 0 =*/56).bool(message.checkBox);
                            if (message.count != null && Object.hasOwnProperty.call(message, "count"))
                                writer.uint32(/* id 8, wireType 0 =*/64).int64(message.count);
                            if (message.commandDms != null && message.commandDms.length)
                                for (let i = 0; i < message.commandDms.length; ++i)
                                    $root.bilibili.community.service.dm.v1.CommandDm.encode(message.commandDms[i], writer.uint32(/* id 9, wireType 2 =*/74).fork()).ldelim();
                            if (message.dmSetting != null && Object.hasOwnProperty.call(message, "dmSetting"))
                                $root.bilibili.community.service.dm.v1.DanmuWebPlayerConfig.encode(message.dmSetting, writer.uint32(/* id 10, wireType 2 =*/82).fork()).ldelim();
                            if (message.reportFilter != null && message.reportFilter.length)
                                for (let i = 0; i < message.reportFilter.length; ++i)
                                    writer.uint32(/* id 11, wireType 2 =*/90).string(message.reportFilter[i]);
                            if (message.expressions != null && message.expressions.length)
                                for (let i = 0; i < message.expressions.length; ++i)
                                    $root.bilibili.community.service.dm.v1.Expressions.encode(message.expressions[i], writer.uint32(/* id 12, wireType 2 =*/98).fork()).ldelim();
                            if (message.postPanel != null && message.postPanel.length)
                                for (let i = 0; i < message.postPanel.length; ++i)
                                    $root.bilibili.community.service.dm.v1.PostPanel.encode(message.postPanel[i], writer.uint32(/* id 13, wireType 2 =*/106).fork()).ldelim();
                            if (message.activityMetas != null && message.activityMetas.length)
                                for (let i = 0; i < message.activityMetas.length; ++i)
                                    writer.uint32(/* id 14, wireType 2 =*/114).string(message.activityMetas[i]);
                            if (message.postPanelV2 != null && message.postPanelV2.length)
                                for (let i = 0; i < message.postPanelV2.length; ++i)
                                    $root.bilibili.community.service.dm.v1.PostPanelV2.encode(message.postPanelV2[i], writer.uint32(/* id 15, wireType 2 =*/122).fork()).ldelim();
                            if (message.subViews != null && message.subViews.length)
                                for (let i = 0; i < message.subViews.length; ++i)
                                    $root.bilibili.community.service.dm.v1.DmSubView.encode(message.subViews[i], writer.uint32(/* id 16, wireType 2 =*/130).fork()).ldelim();
                            if (message.qoe != null && Object.hasOwnProperty.call(message, "qoe"))
                                $root.bilibili.community.service.dm.v1.QoeInfo.encode(message.qoe, writer.uint32(/* id 17, wireType 2 =*/138).fork()).ldelim();
                            if (message.maskWalls != null && message.maskWalls.length)
                                for (let i = 0; i < message.maskWalls.length; ++i)
                                    $root.bilibili.community.service.dm.v1.DmMaskWall.encode(message.maskWalls[i], writer.uint32(/* id 18, wireType 2 =*/146).fork()).ldelim();
                            return writer;
                        };

                        /**
                         * Decodes a DmWebViewReply message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.DmWebViewReply} DmWebViewReply
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        DmWebViewReply.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.DmWebViewReply();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.state = reader.int32();
                                        break;
                                    }
                                case 2: {
                                        message.text = reader.string();
                                        break;
                                    }
                                case 3: {
                                        message.textSide = reader.string();
                                        break;
                                    }
                                case 4: {
                                        message.dmSge = $root.bilibili.community.service.dm.v1.DmSegConfig.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 5: {
                                        message.flag = $root.bilibili.community.service.dm.v1.DanmakuFlagConfig.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 6: {
                                        if (!(message.specialDms && message.specialDms.length))
                                            message.specialDms = [];
                                        message.specialDms.push(reader.string());
                                        break;
                                    }
                                case 7: {
                                        message.checkBox = reader.bool();
                                        break;
                                    }
                                case 8: {
                                        message.count = reader.int64();
                                        break;
                                    }
                                case 9: {
                                        if (!(message.commandDms && message.commandDms.length))
                                            message.commandDms = [];
                                        message.commandDms.push($root.bilibili.community.service.dm.v1.CommandDm.decode(reader, reader.uint32()));
                                        break;
                                    }
                                case 10: {
                                        message.dmSetting = $root.bilibili.community.service.dm.v1.DanmuWebPlayerConfig.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 11: {
                                        if (!(message.reportFilter && message.reportFilter.length))
                                            message.reportFilter = [];
                                        message.reportFilter.push(reader.string());
                                        break;
                                    }
                                case 12: {
                                        if (!(message.expressions && message.expressions.length))
                                            message.expressions = [];
                                        message.expressions.push($root.bilibili.community.service.dm.v1.Expressions.decode(reader, reader.uint32()));
                                        break;
                                    }
                                case 13: {
                                        if (!(message.postPanel && message.postPanel.length))
                                            message.postPanel = [];
                                        message.postPanel.push($root.bilibili.community.service.dm.v1.PostPanel.decode(reader, reader.uint32()));
                                        break;
                                    }
                                case 14: {
                                        if (!(message.activityMetas && message.activityMetas.length))
                                            message.activityMetas = [];
                                        message.activityMetas.push(reader.string());
                                        break;
                                    }
                                case 15: {
                                        if (!(message.postPanelV2 && message.postPanelV2.length))
                                            message.postPanelV2 = [];
                                        message.postPanelV2.push($root.bilibili.community.service.dm.v1.PostPanelV2.decode(reader, reader.uint32()));
                                        break;
                                    }
                                case 16: {
                                        if (!(message.subViews && message.subViews.length))
                                            message.subViews = [];
                                        message.subViews.push($root.bilibili.community.service.dm.v1.DmSubView.decode(reader, reader.uint32()));
                                        break;
                                    }
                                case 17: {
                                        message.qoe = $root.bilibili.community.service.dm.v1.QoeInfo.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 18: {
                                        if (!(message.maskWalls && message.maskWalls.length))
                                            message.maskWalls = [];
                                        message.maskWalls.push($root.bilibili.community.service.dm.v1.DmMaskWall.decode(reader, reader.uint32()));
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for DmWebViewReply
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.DmWebViewReply
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        DmWebViewReply.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.DmWebViewReply";
                        };

                        return DmWebViewReply;
                    })();

                    v1.DmMaskWall = (function() {

                        /**
                         * Properties of a DmMaskWall.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IDmMaskWall
                         * @property {number|null} [start] DmMaskWall start
                         * @property {number|null} [end] DmMaskWall end
                         * @property {string|null} [content] DmMaskWall content
                         * @property {bilibili.community.service.dm.v1.DmMaskWallContentType|null} [contentType] DmMaskWall contentType
                         * @property {bilibili.community.service.dm.v1.DmMaskWallBizType|null} [bizType] DmMaskWall bizType
                         * @property {Array.<bilibili.community.service.dm.v1.IDmMaskWallContent>|null} [contents] DmMaskWall contents
                         */

                        /**
                         * Constructs a new DmMaskWall.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a DmMaskWall.
                         * @implements IDmMaskWall
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IDmMaskWall=} [properties] Properties to set
                         */
                        function DmMaskWall(properties) {
                            this.contents = [];
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * DmMaskWall start.
                         * @member {number} start
                         * @memberof bilibili.community.service.dm.v1.DmMaskWall
                         * @instance
                         */
                        DmMaskWall.prototype.start = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * DmMaskWall end.
                         * @member {number} end
                         * @memberof bilibili.community.service.dm.v1.DmMaskWall
                         * @instance
                         */
                        DmMaskWall.prototype.end = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * DmMaskWall content.
                         * @member {string} content
                         * @memberof bilibili.community.service.dm.v1.DmMaskWall
                         * @instance
                         */
                        DmMaskWall.prototype.content = "";

                        /**
                         * DmMaskWall contentType.
                         * @member {bilibili.community.service.dm.v1.DmMaskWallContentType} contentType
                         * @memberof bilibili.community.service.dm.v1.DmMaskWall
                         * @instance
                         */
                        DmMaskWall.prototype.contentType = 0;

                        /**
                         * DmMaskWall bizType.
                         * @member {bilibili.community.service.dm.v1.DmMaskWallBizType} bizType
                         * @memberof bilibili.community.service.dm.v1.DmMaskWall
                         * @instance
                         */
                        DmMaskWall.prototype.bizType = 0;

                        /**
                         * DmMaskWall contents.
                         * @member {Array.<bilibili.community.service.dm.v1.IDmMaskWallContent>} contents
                         * @memberof bilibili.community.service.dm.v1.DmMaskWall
                         * @instance
                         */
                        DmMaskWall.prototype.contents = $util.emptyArray;

                        /**
                         * Encodes the specified DmMaskWall message. Does not implicitly {@link bilibili.community.service.dm.v1.DmMaskWall.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.DmMaskWall
                         * @static
                         * @param {bilibili.community.service.dm.v1.IDmMaskWall} message DmMaskWall message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        DmMaskWall.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.start != null && Object.hasOwnProperty.call(message, "start"))
                                writer.uint32(/* id 1, wireType 0 =*/8).int64(message.start);
                            if (message.end != null && Object.hasOwnProperty.call(message, "end"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int64(message.end);
                            if (message.content != null && Object.hasOwnProperty.call(message, "content"))
                                writer.uint32(/* id 3, wireType 2 =*/26).string(message.content);
                            if (message.contentType != null && Object.hasOwnProperty.call(message, "contentType"))
                                writer.uint32(/* id 4, wireType 0 =*/32).int32(message.contentType);
                            if (message.bizType != null && Object.hasOwnProperty.call(message, "bizType"))
                                writer.uint32(/* id 5, wireType 0 =*/40).int32(message.bizType);
                            if (message.contents != null && message.contents.length)
                                for (let i = 0; i < message.contents.length; ++i)
                                    $root.bilibili.community.service.dm.v1.DmMaskWallContent.encode(message.contents[i], writer.uint32(/* id 6, wireType 2 =*/50).fork()).ldelim();
                            return writer;
                        };

                        /**
                         * Decodes a DmMaskWall message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.DmMaskWall
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.DmMaskWall} DmMaskWall
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        DmMaskWall.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.DmMaskWall();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.start = reader.int64();
                                        break;
                                    }
                                case 2: {
                                        message.end = reader.int64();
                                        break;
                                    }
                                case 3: {
                                        message.content = reader.string();
                                        break;
                                    }
                                case 4: {
                                        message.contentType = reader.int32();
                                        break;
                                    }
                                case 5: {
                                        message.bizType = reader.int32();
                                        break;
                                    }
                                case 6: {
                                        if (!(message.contents && message.contents.length))
                                            message.contents = [];
                                        message.contents.push($root.bilibili.community.service.dm.v1.DmMaskWallContent.decode(reader, reader.uint32()));
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for DmMaskWall
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.DmMaskWall
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        DmMaskWall.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.DmMaskWall";
                        };

                        return DmMaskWall;
                    })();

                    /**
                     * DmMaskWallBizType enum.
                     * @name bilibili.community.service.dm.v1.DmMaskWallBizType
                     * @enum {number}
                     * @property {number} DmMaskWallBizTypeUnknown=0 DmMaskWallBizTypeUnknown value
                     * @property {number} DmMaskWallBizTypeOGV=1 DmMaskWallBizTypeOGV value
                     * @property {number} DmMaskWallBizTypeBizPic=2 DmMaskWallBizTypeBizPic value
                     * @property {number} DmMaskWallBizTypeMute=3 DmMaskWallBizTypeMute value
                     * @property {number} DmMaskWallBizTypeRecord=4 DmMaskWallBizTypeRecord value
                     */
                    v1.DmMaskWallBizType = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "DmMaskWallBizTypeUnknown"] = 0;
                        values[valuesById[1] = "DmMaskWallBizTypeOGV"] = 1;
                        values[valuesById[2] = "DmMaskWallBizTypeBizPic"] = 2;
                        values[valuesById[3] = "DmMaskWallBizTypeMute"] = 3;
                        values[valuesById[4] = "DmMaskWallBizTypeRecord"] = 4;
                        return values;
                    })();

                    v1.DmMaskWallContent = (function() {

                        /**
                         * Properties of a DmMaskWallContent.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IDmMaskWallContent
                         * @property {bilibili.community.service.dm.v1.DmMaskWallContentType|null} [type] DmMaskWallContent type
                         * @property {string|null} [content] DmMaskWallContent content
                         */

                        /**
                         * Constructs a new DmMaskWallContent.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a DmMaskWallContent.
                         * @implements IDmMaskWallContent
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IDmMaskWallContent=} [properties] Properties to set
                         */
                        function DmMaskWallContent(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * DmMaskWallContent type.
                         * @member {bilibili.community.service.dm.v1.DmMaskWallContentType} type
                         * @memberof bilibili.community.service.dm.v1.DmMaskWallContent
                         * @instance
                         */
                        DmMaskWallContent.prototype.type = 0;

                        /**
                         * DmMaskWallContent content.
                         * @member {string} content
                         * @memberof bilibili.community.service.dm.v1.DmMaskWallContent
                         * @instance
                         */
                        DmMaskWallContent.prototype.content = "";

                        /**
                         * Encodes the specified DmMaskWallContent message. Does not implicitly {@link bilibili.community.service.dm.v1.DmMaskWallContent.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.DmMaskWallContent
                         * @static
                         * @param {bilibili.community.service.dm.v1.IDmMaskWallContent} message DmMaskWallContent message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        DmMaskWallContent.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.type != null && Object.hasOwnProperty.call(message, "type"))
                                writer.uint32(/* id 1, wireType 0 =*/8).int32(message.type);
                            if (message.content != null && Object.hasOwnProperty.call(message, "content"))
                                writer.uint32(/* id 2, wireType 2 =*/18).string(message.content);
                            return writer;
                        };

                        /**
                         * Decodes a DmMaskWallContent message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.DmMaskWallContent
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.DmMaskWallContent} DmMaskWallContent
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        DmMaskWallContent.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.DmMaskWallContent();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.type = reader.int32();
                                        break;
                                    }
                                case 2: {
                                        message.content = reader.string();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for DmMaskWallContent
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.DmMaskWallContent
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        DmMaskWallContent.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.DmMaskWallContent";
                        };

                        return DmMaskWallContent;
                    })();

                    /**
                     * DmMaskWallContentType enum.
                     * @name bilibili.community.service.dm.v1.DmMaskWallContentType
                     * @enum {number}
                     * @property {number} DmMaskWallContentTypeUnknown=0 DmMaskWallContentTypeUnknown value
                     * @property {number} DmMaskWallContentTypeText=1 DmMaskWallContentTypeText value
                     * @property {number} DmMaskWallContentTypePic=2 DmMaskWallContentTypePic value
                     */
                    v1.DmMaskWallContentType = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "DmMaskWallContentTypeUnknown"] = 0;
                        values[valuesById[1] = "DmMaskWallContentTypeText"] = 1;
                        values[valuesById[2] = "DmMaskWallContentTypePic"] = 2;
                        return values;
                    })();

                    v1.QoeInfo = (function() {

                        /**
                         * Properties of a QoeInfo.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IQoeInfo
                         * @property {string|null} [info] QoeInfo info
                         */

                        /**
                         * Constructs a new QoeInfo.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a QoeInfo.
                         * @implements IQoeInfo
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IQoeInfo=} [properties] Properties to set
                         */
                        function QoeInfo(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * QoeInfo info.
                         * @member {string} info
                         * @memberof bilibili.community.service.dm.v1.QoeInfo
                         * @instance
                         */
                        QoeInfo.prototype.info = "";

                        /**
                         * Encodes the specified QoeInfo message. Does not implicitly {@link bilibili.community.service.dm.v1.QoeInfo.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.QoeInfo
                         * @static
                         * @param {bilibili.community.service.dm.v1.IQoeInfo} message QoeInfo message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        QoeInfo.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.info != null && Object.hasOwnProperty.call(message, "info"))
                                writer.uint32(/* id 1, wireType 2 =*/10).string(message.info);
                            return writer;
                        };

                        /**
                         * Decodes a QoeInfo message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.QoeInfo
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.QoeInfo} QoeInfo
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        QoeInfo.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.QoeInfo();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.info = reader.string();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for QoeInfo
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.QoeInfo
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        QoeInfo.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.QoeInfo";
                        };

                        return QoeInfo;
                    })();

                    v1.PostPanel = (function() {

                        /**
                         * Properties of a PostPanel.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IPostPanel
                         * @property {number|null} [start] PostPanel start
                         * @property {number|null} [end] PostPanel end
                         * @property {number|null} [priority] PostPanel priority
                         * @property {number|null} [bizId] PostPanel bizId
                         * @property {bilibili.community.service.dm.v1.PostPanelBizType|null} [bizType] PostPanel bizType
                         * @property {bilibili.community.service.dm.v1.IClickButton|null} [clickButton] PostPanel clickButton
                         * @property {bilibili.community.service.dm.v1.ITextInput|null} [textInput] PostPanel textInput
                         * @property {bilibili.community.service.dm.v1.ICheckBox|null} [checkBox] PostPanel checkBox
                         * @property {bilibili.community.service.dm.v1.IToast|null} [toast] PostPanel toast
                         */

                        /**
                         * Constructs a new PostPanel.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a PostPanel.
                         * @implements IPostPanel
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IPostPanel=} [properties] Properties to set
                         */
                        function PostPanel(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * PostPanel start.
                         * @member {number} start
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @instance
                         */
                        PostPanel.prototype.start = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * PostPanel end.
                         * @member {number} end
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @instance
                         */
                        PostPanel.prototype.end = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * PostPanel priority.
                         * @member {number} priority
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @instance
                         */
                        PostPanel.prototype.priority = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * PostPanel bizId.
                         * @member {number} bizId
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @instance
                         */
                        PostPanel.prototype.bizId = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * PostPanel bizType.
                         * @member {bilibili.community.service.dm.v1.PostPanelBizType} bizType
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @instance
                         */
                        PostPanel.prototype.bizType = 0;

                        /**
                         * PostPanel clickButton.
                         * @member {bilibili.community.service.dm.v1.IClickButton|null|undefined} clickButton
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @instance
                         */
                        PostPanel.prototype.clickButton = null;

                        /**
                         * PostPanel textInput.
                         * @member {bilibili.community.service.dm.v1.ITextInput|null|undefined} textInput
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @instance
                         */
                        PostPanel.prototype.textInput = null;

                        /**
                         * PostPanel checkBox.
                         * @member {bilibili.community.service.dm.v1.ICheckBox|null|undefined} checkBox
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @instance
                         */
                        PostPanel.prototype.checkBox = null;

                        /**
                         * PostPanel toast.
                         * @member {bilibili.community.service.dm.v1.IToast|null|undefined} toast
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @instance
                         */
                        PostPanel.prototype.toast = null;

                        /**
                         * Encodes the specified PostPanel message. Does not implicitly {@link bilibili.community.service.dm.v1.PostPanel.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @static
                         * @param {bilibili.community.service.dm.v1.IPostPanel} message PostPanel message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        PostPanel.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.start != null && Object.hasOwnProperty.call(message, "start"))
                                writer.uint32(/* id 1, wireType 0 =*/8).int64(message.start);
                            if (message.end != null && Object.hasOwnProperty.call(message, "end"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int64(message.end);
                            if (message.priority != null && Object.hasOwnProperty.call(message, "priority"))
                                writer.uint32(/* id 3, wireType 0 =*/24).int64(message.priority);
                            if (message.bizId != null && Object.hasOwnProperty.call(message, "bizId"))
                                writer.uint32(/* id 4, wireType 0 =*/32).int64(message.bizId);
                            if (message.bizType != null && Object.hasOwnProperty.call(message, "bizType"))
                                writer.uint32(/* id 5, wireType 0 =*/40).int32(message.bizType);
                            if (message.clickButton != null && Object.hasOwnProperty.call(message, "clickButton"))
                                $root.bilibili.community.service.dm.v1.ClickButton.encode(message.clickButton, writer.uint32(/* id 6, wireType 2 =*/50).fork()).ldelim();
                            if (message.textInput != null && Object.hasOwnProperty.call(message, "textInput"))
                                $root.bilibili.community.service.dm.v1.TextInput.encode(message.textInput, writer.uint32(/* id 7, wireType 2 =*/58).fork()).ldelim();
                            if (message.checkBox != null && Object.hasOwnProperty.call(message, "checkBox"))
                                $root.bilibili.community.service.dm.v1.CheckBox.encode(message.checkBox, writer.uint32(/* id 8, wireType 2 =*/66).fork()).ldelim();
                            if (message.toast != null && Object.hasOwnProperty.call(message, "toast"))
                                $root.bilibili.community.service.dm.v1.Toast.encode(message.toast, writer.uint32(/* id 9, wireType 2 =*/74).fork()).ldelim();
                            return writer;
                        };

                        /**
                         * Decodes a PostPanel message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.PostPanel} PostPanel
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        PostPanel.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.PostPanel();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.start = reader.int64();
                                        break;
                                    }
                                case 2: {
                                        message.end = reader.int64();
                                        break;
                                    }
                                case 3: {
                                        message.priority = reader.int64();
                                        break;
                                    }
                                case 4: {
                                        message.bizId = reader.int64();
                                        break;
                                    }
                                case 5: {
                                        message.bizType = reader.int32();
                                        break;
                                    }
                                case 6: {
                                        message.clickButton = $root.bilibili.community.service.dm.v1.ClickButton.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 7: {
                                        message.textInput = $root.bilibili.community.service.dm.v1.TextInput.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 8: {
                                        message.checkBox = $root.bilibili.community.service.dm.v1.CheckBox.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 9: {
                                        message.toast = $root.bilibili.community.service.dm.v1.Toast.decode(reader, reader.uint32());
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for PostPanel
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.PostPanel
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        PostPanel.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.PostPanel";
                        };

                        return PostPanel;
                    })();

                    v1.PostPanelV2 = (function() {

                        /**
                         * Properties of a PostPanelV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IPostPanelV2
                         * @property {number|null} [start] PostPanelV2 start
                         * @property {number|null} [end] PostPanelV2 end
                         * @property {bilibili.community.service.dm.v1.PostPanelBizType|null} [bizType] PostPanelV2 bizType
                         * @property {bilibili.community.service.dm.v1.IClickButtonV2|null} [clickButton] PostPanelV2 clickButton
                         * @property {bilibili.community.service.dm.v1.ITextInputV2|null} [textInput] PostPanelV2 textInput
                         * @property {bilibili.community.service.dm.v1.ICheckBoxV2|null} [checkBox] PostPanelV2 checkBox
                         * @property {bilibili.community.service.dm.v1.IToastV2|null} [toast] PostPanelV2 toast
                         * @property {bilibili.community.service.dm.v1.IBubbleV2|null} [bubble] PostPanelV2 bubble
                         * @property {bilibili.community.service.dm.v1.ILabelV2|null} [label] PostPanelV2 label
                         * @property {bilibili.community.service.dm.v1.PostStatus|null} [postStatus] PostPanelV2 postStatus
                         */

                        /**
                         * Constructs a new PostPanelV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a PostPanelV2.
                         * @implements IPostPanelV2
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IPostPanelV2=} [properties] Properties to set
                         */
                        function PostPanelV2(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * PostPanelV2 start.
                         * @member {number} start
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @instance
                         */
                        PostPanelV2.prototype.start = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * PostPanelV2 end.
                         * @member {number} end
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @instance
                         */
                        PostPanelV2.prototype.end = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * PostPanelV2 bizType.
                         * @member {bilibili.community.service.dm.v1.PostPanelBizType} bizType
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @instance
                         */
                        PostPanelV2.prototype.bizType = 0;

                        /**
                         * PostPanelV2 clickButton.
                         * @member {bilibili.community.service.dm.v1.IClickButtonV2|null|undefined} clickButton
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @instance
                         */
                        PostPanelV2.prototype.clickButton = null;

                        /**
                         * PostPanelV2 textInput.
                         * @member {bilibili.community.service.dm.v1.ITextInputV2|null|undefined} textInput
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @instance
                         */
                        PostPanelV2.prototype.textInput = null;

                        /**
                         * PostPanelV2 checkBox.
                         * @member {bilibili.community.service.dm.v1.ICheckBoxV2|null|undefined} checkBox
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @instance
                         */
                        PostPanelV2.prototype.checkBox = null;

                        /**
                         * PostPanelV2 toast.
                         * @member {bilibili.community.service.dm.v1.IToastV2|null|undefined} toast
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @instance
                         */
                        PostPanelV2.prototype.toast = null;

                        /**
                         * PostPanelV2 bubble.
                         * @member {bilibili.community.service.dm.v1.IBubbleV2|null|undefined} bubble
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @instance
                         */
                        PostPanelV2.prototype.bubble = null;

                        /**
                         * PostPanelV2 label.
                         * @member {bilibili.community.service.dm.v1.ILabelV2|null|undefined} label
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @instance
                         */
                        PostPanelV2.prototype.label = null;

                        /**
                         * PostPanelV2 postStatus.
                         * @member {bilibili.community.service.dm.v1.PostStatus} postStatus
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @instance
                         */
                        PostPanelV2.prototype.postStatus = 0;

                        /**
                         * Encodes the specified PostPanelV2 message. Does not implicitly {@link bilibili.community.service.dm.v1.PostPanelV2.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @static
                         * @param {bilibili.community.service.dm.v1.IPostPanelV2} message PostPanelV2 message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        PostPanelV2.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.start != null && Object.hasOwnProperty.call(message, "start"))
                                writer.uint32(/* id 1, wireType 0 =*/8).int64(message.start);
                            if (message.end != null && Object.hasOwnProperty.call(message, "end"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int64(message.end);
                            if (message.bizType != null && Object.hasOwnProperty.call(message, "bizType"))
                                writer.uint32(/* id 3, wireType 0 =*/24).int32(message.bizType);
                            if (message.clickButton != null && Object.hasOwnProperty.call(message, "clickButton"))
                                $root.bilibili.community.service.dm.v1.ClickButtonV2.encode(message.clickButton, writer.uint32(/* id 4, wireType 2 =*/34).fork()).ldelim();
                            if (message.textInput != null && Object.hasOwnProperty.call(message, "textInput"))
                                $root.bilibili.community.service.dm.v1.TextInputV2.encode(message.textInput, writer.uint32(/* id 5, wireType 2 =*/42).fork()).ldelim();
                            if (message.checkBox != null && Object.hasOwnProperty.call(message, "checkBox"))
                                $root.bilibili.community.service.dm.v1.CheckBoxV2.encode(message.checkBox, writer.uint32(/* id 6, wireType 2 =*/50).fork()).ldelim();
                            if (message.toast != null && Object.hasOwnProperty.call(message, "toast"))
                                $root.bilibili.community.service.dm.v1.ToastV2.encode(message.toast, writer.uint32(/* id 7, wireType 2 =*/58).fork()).ldelim();
                            if (message.bubble != null && Object.hasOwnProperty.call(message, "bubble"))
                                $root.bilibili.community.service.dm.v1.BubbleV2.encode(message.bubble, writer.uint32(/* id 8, wireType 2 =*/66).fork()).ldelim();
                            if (message.label != null && Object.hasOwnProperty.call(message, "label"))
                                $root.bilibili.community.service.dm.v1.LabelV2.encode(message.label, writer.uint32(/* id 9, wireType 2 =*/74).fork()).ldelim();
                            if (message.postStatus != null && Object.hasOwnProperty.call(message, "postStatus"))
                                writer.uint32(/* id 10, wireType 0 =*/80).int32(message.postStatus);
                            return writer;
                        };

                        /**
                         * Decodes a PostPanelV2 message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.PostPanelV2} PostPanelV2
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        PostPanelV2.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.PostPanelV2();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.start = reader.int64();
                                        break;
                                    }
                                case 2: {
                                        message.end = reader.int64();
                                        break;
                                    }
                                case 3: {
                                        message.bizType = reader.int32();
                                        break;
                                    }
                                case 4: {
                                        message.clickButton = $root.bilibili.community.service.dm.v1.ClickButtonV2.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 5: {
                                        message.textInput = $root.bilibili.community.service.dm.v1.TextInputV2.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 6: {
                                        message.checkBox = $root.bilibili.community.service.dm.v1.CheckBoxV2.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 7: {
                                        message.toast = $root.bilibili.community.service.dm.v1.ToastV2.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 8: {
                                        message.bubble = $root.bilibili.community.service.dm.v1.BubbleV2.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 9: {
                                        message.label = $root.bilibili.community.service.dm.v1.LabelV2.decode(reader, reader.uint32());
                                        break;
                                    }
                                case 10: {
                                        message.postStatus = reader.int32();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for PostPanelV2
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.PostPanelV2
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        PostPanelV2.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.PostPanelV2";
                        };

                        return PostPanelV2;
                    })();

                    v1.ClickButton = (function() {

                        /**
                         * Properties of a ClickButton.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IClickButton
                         * @property {Array.<string>|null} [portraitText] ClickButton portraitText
                         * @property {Array.<string>|null} [landscapeText] ClickButton landscapeText
                         * @property {Array.<string>|null} [portraitTextFocus] ClickButton portraitTextFocus
                         * @property {Array.<string>|null} [landscapeTextFocus] ClickButton landscapeTextFocus
                         * @property {bilibili.community.service.dm.v1.RenderType|null} [renderType] ClickButton renderType
                         * @property {boolean|null} [show] ClickButton show
                         */

                        /**
                         * Constructs a new ClickButton.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a ClickButton.
                         * @implements IClickButton
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IClickButton=} [properties] Properties to set
                         */
                        function ClickButton(properties) {
                            this.portraitText = [];
                            this.landscapeText = [];
                            this.portraitTextFocus = [];
                            this.landscapeTextFocus = [];
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * ClickButton portraitText.
                         * @member {Array.<string>} portraitText
                         * @memberof bilibili.community.service.dm.v1.ClickButton
                         * @instance
                         */
                        ClickButton.prototype.portraitText = $util.emptyArray;

                        /**
                         * ClickButton landscapeText.
                         * @member {Array.<string>} landscapeText
                         * @memberof bilibili.community.service.dm.v1.ClickButton
                         * @instance
                         */
                        ClickButton.prototype.landscapeText = $util.emptyArray;

                        /**
                         * ClickButton portraitTextFocus.
                         * @member {Array.<string>} portraitTextFocus
                         * @memberof bilibili.community.service.dm.v1.ClickButton
                         * @instance
                         */
                        ClickButton.prototype.portraitTextFocus = $util.emptyArray;

                        /**
                         * ClickButton landscapeTextFocus.
                         * @member {Array.<string>} landscapeTextFocus
                         * @memberof bilibili.community.service.dm.v1.ClickButton
                         * @instance
                         */
                        ClickButton.prototype.landscapeTextFocus = $util.emptyArray;

                        /**
                         * ClickButton renderType.
                         * @member {bilibili.community.service.dm.v1.RenderType} renderType
                         * @memberof bilibili.community.service.dm.v1.ClickButton
                         * @instance
                         */
                        ClickButton.prototype.renderType = 0;

                        /**
                         * ClickButton show.
                         * @member {boolean} show
                         * @memberof bilibili.community.service.dm.v1.ClickButton
                         * @instance
                         */
                        ClickButton.prototype.show = false;

                        /**
                         * Encodes the specified ClickButton message. Does not implicitly {@link bilibili.community.service.dm.v1.ClickButton.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.ClickButton
                         * @static
                         * @param {bilibili.community.service.dm.v1.IClickButton} message ClickButton message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        ClickButton.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.portraitText != null && message.portraitText.length)
                                for (let i = 0; i < message.portraitText.length; ++i)
                                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.portraitText[i]);
                            if (message.landscapeText != null && message.landscapeText.length)
                                for (let i = 0; i < message.landscapeText.length; ++i)
                                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.landscapeText[i]);
                            if (message.portraitTextFocus != null && message.portraitTextFocus.length)
                                for (let i = 0; i < message.portraitTextFocus.length; ++i)
                                    writer.uint32(/* id 3, wireType 2 =*/26).string(message.portraitTextFocus[i]);
                            if (message.landscapeTextFocus != null && message.landscapeTextFocus.length)
                                for (let i = 0; i < message.landscapeTextFocus.length; ++i)
                                    writer.uint32(/* id 4, wireType 2 =*/34).string(message.landscapeTextFocus[i]);
                            if (message.renderType != null && Object.hasOwnProperty.call(message, "renderType"))
                                writer.uint32(/* id 5, wireType 0 =*/40).int32(message.renderType);
                            if (message.show != null && Object.hasOwnProperty.call(message, "show"))
                                writer.uint32(/* id 6, wireType 0 =*/48).bool(message.show);
                            return writer;
                        };

                        /**
                         * Decodes a ClickButton message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.ClickButton
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.ClickButton} ClickButton
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        ClickButton.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.ClickButton();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        if (!(message.portraitText && message.portraitText.length))
                                            message.portraitText = [];
                                        message.portraitText.push(reader.string());
                                        break;
                                    }
                                case 2: {
                                        if (!(message.landscapeText && message.landscapeText.length))
                                            message.landscapeText = [];
                                        message.landscapeText.push(reader.string());
                                        break;
                                    }
                                case 3: {
                                        if (!(message.portraitTextFocus && message.portraitTextFocus.length))
                                            message.portraitTextFocus = [];
                                        message.portraitTextFocus.push(reader.string());
                                        break;
                                    }
                                case 4: {
                                        if (!(message.landscapeTextFocus && message.landscapeTextFocus.length))
                                            message.landscapeTextFocus = [];
                                        message.landscapeTextFocus.push(reader.string());
                                        break;
                                    }
                                case 5: {
                                        message.renderType = reader.int32();
                                        break;
                                    }
                                case 6: {
                                        message.show = reader.bool();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for ClickButton
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.ClickButton
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        ClickButton.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.ClickButton";
                        };

                        return ClickButton;
                    })();

                    v1.ClickButtonV2 = (function() {

                        /**
                         * Properties of a ClickButtonV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IClickButtonV2
                         * @property {Array.<string>|null} [portraitText] ClickButtonV2 portraitText
                         * @property {Array.<string>|null} [landscapeText] ClickButtonV2 landscapeText
                         * @property {Array.<string>|null} [portraitTextFocus] ClickButtonV2 portraitTextFocus
                         * @property {Array.<string>|null} [landscapeTextFocus] ClickButtonV2 landscapeTextFocus
                         * @property {bilibili.community.service.dm.v1.RenderType|null} [renderType] ClickButtonV2 renderType
                         * @property {boolean|null} [textInputPost] ClickButtonV2 textInputPost
                         * @property {boolean|null} [exposureOnce] ClickButtonV2 exposureOnce
                         * @property {bilibili.community.service.dm.v1.ExposureType|null} [exposureType] ClickButtonV2 exposureType
                         */

                        /**
                         * Constructs a new ClickButtonV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a ClickButtonV2.
                         * @implements IClickButtonV2
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IClickButtonV2=} [properties] Properties to set
                         */
                        function ClickButtonV2(properties) {
                            this.portraitText = [];
                            this.landscapeText = [];
                            this.portraitTextFocus = [];
                            this.landscapeTextFocus = [];
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * ClickButtonV2 portraitText.
                         * @member {Array.<string>} portraitText
                         * @memberof bilibili.community.service.dm.v1.ClickButtonV2
                         * @instance
                         */
                        ClickButtonV2.prototype.portraitText = $util.emptyArray;

                        /**
                         * ClickButtonV2 landscapeText.
                         * @member {Array.<string>} landscapeText
                         * @memberof bilibili.community.service.dm.v1.ClickButtonV2
                         * @instance
                         */
                        ClickButtonV2.prototype.landscapeText = $util.emptyArray;

                        /**
                         * ClickButtonV2 portraitTextFocus.
                         * @member {Array.<string>} portraitTextFocus
                         * @memberof bilibili.community.service.dm.v1.ClickButtonV2
                         * @instance
                         */
                        ClickButtonV2.prototype.portraitTextFocus = $util.emptyArray;

                        /**
                         * ClickButtonV2 landscapeTextFocus.
                         * @member {Array.<string>} landscapeTextFocus
                         * @memberof bilibili.community.service.dm.v1.ClickButtonV2
                         * @instance
                         */
                        ClickButtonV2.prototype.landscapeTextFocus = $util.emptyArray;

                        /**
                         * ClickButtonV2 renderType.
                         * @member {bilibili.community.service.dm.v1.RenderType} renderType
                         * @memberof bilibili.community.service.dm.v1.ClickButtonV2
                         * @instance
                         */
                        ClickButtonV2.prototype.renderType = 0;

                        /**
                         * ClickButtonV2 textInputPost.
                         * @member {boolean} textInputPost
                         * @memberof bilibili.community.service.dm.v1.ClickButtonV2
                         * @instance
                         */
                        ClickButtonV2.prototype.textInputPost = false;

                        /**
                         * ClickButtonV2 exposureOnce.
                         * @member {boolean} exposureOnce
                         * @memberof bilibili.community.service.dm.v1.ClickButtonV2
                         * @instance
                         */
                        ClickButtonV2.prototype.exposureOnce = false;

                        /**
                         * ClickButtonV2 exposureType.
                         * @member {bilibili.community.service.dm.v1.ExposureType} exposureType
                         * @memberof bilibili.community.service.dm.v1.ClickButtonV2
                         * @instance
                         */
                        ClickButtonV2.prototype.exposureType = 0;

                        /**
                         * Encodes the specified ClickButtonV2 message. Does not implicitly {@link bilibili.community.service.dm.v1.ClickButtonV2.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.ClickButtonV2
                         * @static
                         * @param {bilibili.community.service.dm.v1.IClickButtonV2} message ClickButtonV2 message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        ClickButtonV2.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.portraitText != null && message.portraitText.length)
                                for (let i = 0; i < message.portraitText.length; ++i)
                                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.portraitText[i]);
                            if (message.landscapeText != null && message.landscapeText.length)
                                for (let i = 0; i < message.landscapeText.length; ++i)
                                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.landscapeText[i]);
                            if (message.portraitTextFocus != null && message.portraitTextFocus.length)
                                for (let i = 0; i < message.portraitTextFocus.length; ++i)
                                    writer.uint32(/* id 3, wireType 2 =*/26).string(message.portraitTextFocus[i]);
                            if (message.landscapeTextFocus != null && message.landscapeTextFocus.length)
                                for (let i = 0; i < message.landscapeTextFocus.length; ++i)
                                    writer.uint32(/* id 4, wireType 2 =*/34).string(message.landscapeTextFocus[i]);
                            if (message.renderType != null && Object.hasOwnProperty.call(message, "renderType"))
                                writer.uint32(/* id 5, wireType 0 =*/40).int32(message.renderType);
                            if (message.textInputPost != null && Object.hasOwnProperty.call(message, "textInputPost"))
                                writer.uint32(/* id 6, wireType 0 =*/48).bool(message.textInputPost);
                            if (message.exposureOnce != null && Object.hasOwnProperty.call(message, "exposureOnce"))
                                writer.uint32(/* id 7, wireType 0 =*/56).bool(message.exposureOnce);
                            if (message.exposureType != null && Object.hasOwnProperty.call(message, "exposureType"))
                                writer.uint32(/* id 8, wireType 0 =*/64).int32(message.exposureType);
                            return writer;
                        };

                        /**
                         * Decodes a ClickButtonV2 message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.ClickButtonV2
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.ClickButtonV2} ClickButtonV2
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        ClickButtonV2.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.ClickButtonV2();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        if (!(message.portraitText && message.portraitText.length))
                                            message.portraitText = [];
                                        message.portraitText.push(reader.string());
                                        break;
                                    }
                                case 2: {
                                        if (!(message.landscapeText && message.landscapeText.length))
                                            message.landscapeText = [];
                                        message.landscapeText.push(reader.string());
                                        break;
                                    }
                                case 3: {
                                        if (!(message.portraitTextFocus && message.portraitTextFocus.length))
                                            message.portraitTextFocus = [];
                                        message.portraitTextFocus.push(reader.string());
                                        break;
                                    }
                                case 4: {
                                        if (!(message.landscapeTextFocus && message.landscapeTextFocus.length))
                                            message.landscapeTextFocus = [];
                                        message.landscapeTextFocus.push(reader.string());
                                        break;
                                    }
                                case 5: {
                                        message.renderType = reader.int32();
                                        break;
                                    }
                                case 6: {
                                        message.textInputPost = reader.bool();
                                        break;
                                    }
                                case 7: {
                                        message.exposureOnce = reader.bool();
                                        break;
                                    }
                                case 8: {
                                        message.exposureType = reader.int32();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for ClickButtonV2
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.ClickButtonV2
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        ClickButtonV2.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.ClickButtonV2";
                        };

                        return ClickButtonV2;
                    })();

                    /**
                     * PostPanelBizType enum.
                     * @name bilibili.community.service.dm.v1.PostPanelBizType
                     * @enum {number}
                     * @property {number} PostPanelBizTypeNone=0 PostPanelBizTypeNone value
                     * @property {number} PostPanelBizTypeEncourage=1 PostPanelBizTypeEncourage value
                     * @property {number} PostPanelBizTypeFragClose=4 PostPanelBizTypeFragClose value
                     * @property {number} PostPanelBizTypeColorDM=2 PostPanelBizTypeColorDM value
                     */
                    v1.PostPanelBizType = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "PostPanelBizTypeNone"] = 0;
                        values[valuesById[1] = "PostPanelBizTypeEncourage"] = 1;
                        values[valuesById[4] = "PostPanelBizTypeFragClose"] = 4;
                        values[valuesById[2] = "PostPanelBizTypeColorDM"] = 2;
                        return values;
                    })();

                    v1.TextInput = (function() {

                        /**
                         * Properties of a TextInput.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface ITextInput
                         * @property {Array.<string>|null} [portraitPlaceholder] TextInput portraitPlaceholder
                         * @property {Array.<string>|null} [landscapePlaceholder] TextInput landscapePlaceholder
                         * @property {bilibili.community.service.dm.v1.RenderType|null} [renderType] TextInput renderType
                         * @property {boolean|null} [placeholderPost] TextInput placeholderPost
                         * @property {boolean|null} [show] TextInput show
                         * @property {bilibili.community.service.dm.v1.PostStatus|null} [postStatus] TextInput postStatus
                         */

                        /**
                         * Constructs a new TextInput.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a TextInput.
                         * @implements ITextInput
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.ITextInput=} [properties] Properties to set
                         */
                        function TextInput(properties) {
                            this.portraitPlaceholder = [];
                            this.landscapePlaceholder = [];
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * TextInput portraitPlaceholder.
                         * @member {Array.<string>} portraitPlaceholder
                         * @memberof bilibili.community.service.dm.v1.TextInput
                         * @instance
                         */
                        TextInput.prototype.portraitPlaceholder = $util.emptyArray;

                        /**
                         * TextInput landscapePlaceholder.
                         * @member {Array.<string>} landscapePlaceholder
                         * @memberof bilibili.community.service.dm.v1.TextInput
                         * @instance
                         */
                        TextInput.prototype.landscapePlaceholder = $util.emptyArray;

                        /**
                         * TextInput renderType.
                         * @member {bilibili.community.service.dm.v1.RenderType} renderType
                         * @memberof bilibili.community.service.dm.v1.TextInput
                         * @instance
                         */
                        TextInput.prototype.renderType = 0;

                        /**
                         * TextInput placeholderPost.
                         * @member {boolean} placeholderPost
                         * @memberof bilibili.community.service.dm.v1.TextInput
                         * @instance
                         */
                        TextInput.prototype.placeholderPost = false;

                        /**
                         * TextInput show.
                         * @member {boolean} show
                         * @memberof bilibili.community.service.dm.v1.TextInput
                         * @instance
                         */
                        TextInput.prototype.show = false;

                        /**
                         * TextInput postStatus.
                         * @member {bilibili.community.service.dm.v1.PostStatus} postStatus
                         * @memberof bilibili.community.service.dm.v1.TextInput
                         * @instance
                         */
                        TextInput.prototype.postStatus = 0;

                        /**
                         * Encodes the specified TextInput message. Does not implicitly {@link bilibili.community.service.dm.v1.TextInput.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.TextInput
                         * @static
                         * @param {bilibili.community.service.dm.v1.ITextInput} message TextInput message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        TextInput.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.portraitPlaceholder != null && message.portraitPlaceholder.length)
                                for (let i = 0; i < message.portraitPlaceholder.length; ++i)
                                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.portraitPlaceholder[i]);
                            if (message.landscapePlaceholder != null && message.landscapePlaceholder.length)
                                for (let i = 0; i < message.landscapePlaceholder.length; ++i)
                                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.landscapePlaceholder[i]);
                            if (message.renderType != null && Object.hasOwnProperty.call(message, "renderType"))
                                writer.uint32(/* id 3, wireType 0 =*/24).int32(message.renderType);
                            if (message.placeholderPost != null && Object.hasOwnProperty.call(message, "placeholderPost"))
                                writer.uint32(/* id 4, wireType 0 =*/32).bool(message.placeholderPost);
                            if (message.show != null && Object.hasOwnProperty.call(message, "show"))
                                writer.uint32(/* id 5, wireType 0 =*/40).bool(message.show);
                            if (message.postStatus != null && Object.hasOwnProperty.call(message, "postStatus"))
                                writer.uint32(/* id 7, wireType 0 =*/56).int32(message.postStatus);
                            return writer;
                        };

                        /**
                         * Decodes a TextInput message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.TextInput
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.TextInput} TextInput
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        TextInput.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.TextInput();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        if (!(message.portraitPlaceholder && message.portraitPlaceholder.length))
                                            message.portraitPlaceholder = [];
                                        message.portraitPlaceholder.push(reader.string());
                                        break;
                                    }
                                case 2: {
                                        if (!(message.landscapePlaceholder && message.landscapePlaceholder.length))
                                            message.landscapePlaceholder = [];
                                        message.landscapePlaceholder.push(reader.string());
                                        break;
                                    }
                                case 3: {
                                        message.renderType = reader.int32();
                                        break;
                                    }
                                case 4: {
                                        message.placeholderPost = reader.bool();
                                        break;
                                    }
                                case 5: {
                                        message.show = reader.bool();
                                        break;
                                    }
                                case 7: {
                                        message.postStatus = reader.int32();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for TextInput
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.TextInput
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        TextInput.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.TextInput";
                        };

                        return TextInput;
                    })();

                    v1.TextInputV2 = (function() {

                        /**
                         * Properties of a TextInputV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface ITextInputV2
                         * @property {Array.<string>|null} [portraitPlaceholder] TextInputV2 portraitPlaceholder
                         * @property {Array.<string>|null} [landscapePlaceholder] TextInputV2 landscapePlaceholder
                         * @property {bilibili.community.service.dm.v1.RenderType|null} [renderType] TextInputV2 renderType
                         * @property {boolean|null} [placeholderPost] TextInputV2 placeholderPost
                         * @property {number|null} [textInputLimit] TextInputV2 textInputLimit
                         */

                        /**
                         * Constructs a new TextInputV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a TextInputV2.
                         * @implements ITextInputV2
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.ITextInputV2=} [properties] Properties to set
                         */
                        function TextInputV2(properties) {
                            this.portraitPlaceholder = [];
                            this.landscapePlaceholder = [];
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * TextInputV2 portraitPlaceholder.
                         * @member {Array.<string>} portraitPlaceholder
                         * @memberof bilibili.community.service.dm.v1.TextInputV2
                         * @instance
                         */
                        TextInputV2.prototype.portraitPlaceholder = $util.emptyArray;

                        /**
                         * TextInputV2 landscapePlaceholder.
                         * @member {Array.<string>} landscapePlaceholder
                         * @memberof bilibili.community.service.dm.v1.TextInputV2
                         * @instance
                         */
                        TextInputV2.prototype.landscapePlaceholder = $util.emptyArray;

                        /**
                         * TextInputV2 renderType.
                         * @member {bilibili.community.service.dm.v1.RenderType} renderType
                         * @memberof bilibili.community.service.dm.v1.TextInputV2
                         * @instance
                         */
                        TextInputV2.prototype.renderType = 0;

                        /**
                         * TextInputV2 placeholderPost.
                         * @member {boolean} placeholderPost
                         * @memberof bilibili.community.service.dm.v1.TextInputV2
                         * @instance
                         */
                        TextInputV2.prototype.placeholderPost = false;

                        /**
                         * TextInputV2 textInputLimit.
                         * @member {number} textInputLimit
                         * @memberof bilibili.community.service.dm.v1.TextInputV2
                         * @instance
                         */
                        TextInputV2.prototype.textInputLimit = 0;

                        /**
                         * Encodes the specified TextInputV2 message. Does not implicitly {@link bilibili.community.service.dm.v1.TextInputV2.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.TextInputV2
                         * @static
                         * @param {bilibili.community.service.dm.v1.ITextInputV2} message TextInputV2 message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        TextInputV2.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.portraitPlaceholder != null && message.portraitPlaceholder.length)
                                for (let i = 0; i < message.portraitPlaceholder.length; ++i)
                                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.portraitPlaceholder[i]);
                            if (message.landscapePlaceholder != null && message.landscapePlaceholder.length)
                                for (let i = 0; i < message.landscapePlaceholder.length; ++i)
                                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.landscapePlaceholder[i]);
                            if (message.renderType != null && Object.hasOwnProperty.call(message, "renderType"))
                                writer.uint32(/* id 3, wireType 0 =*/24).int32(message.renderType);
                            if (message.placeholderPost != null && Object.hasOwnProperty.call(message, "placeholderPost"))
                                writer.uint32(/* id 4, wireType 0 =*/32).bool(message.placeholderPost);
                            if (message.textInputLimit != null && Object.hasOwnProperty.call(message, "textInputLimit"))
                                writer.uint32(/* id 6, wireType 0 =*/48).int32(message.textInputLimit);
                            return writer;
                        };

                        /**
                         * Decodes a TextInputV2 message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.TextInputV2
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.TextInputV2} TextInputV2
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        TextInputV2.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.TextInputV2();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        if (!(message.portraitPlaceholder && message.portraitPlaceholder.length))
                                            message.portraitPlaceholder = [];
                                        message.portraitPlaceholder.push(reader.string());
                                        break;
                                    }
                                case 2: {
                                        if (!(message.landscapePlaceholder && message.landscapePlaceholder.length))
                                            message.landscapePlaceholder = [];
                                        message.landscapePlaceholder.push(reader.string());
                                        break;
                                    }
                                case 3: {
                                        message.renderType = reader.int32();
                                        break;
                                    }
                                case 4: {
                                        message.placeholderPost = reader.bool();
                                        break;
                                    }
                                case 6: {
                                        message.textInputLimit = reader.int32();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for TextInputV2
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.TextInputV2
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        TextInputV2.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.TextInputV2";
                        };

                        return TextInputV2;
                    })();

                    /**
                     * PostStatus enum.
                     * @name bilibili.community.service.dm.v1.PostStatus
                     * @enum {number}
                     * @property {number} PostStatusNormal=0 PostStatusNormal value
                     * @property {number} PostStatusClosed=1 PostStatusClosed value
                     */
                    v1.PostStatus = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "PostStatusNormal"] = 0;
                        values[valuesById[1] = "PostStatusClosed"] = 1;
                        return values;
                    })();

                    /**
                     * RenderType enum.
                     * @name bilibili.community.service.dm.v1.RenderType
                     * @enum {number}
                     * @property {number} RenderTypeNone=0 RenderTypeNone value
                     * @property {number} RenderTypeSingle=1 RenderTypeSingle value
                     * @property {number} RenderTypeRotation=2 RenderTypeRotation value
                     */
                    v1.RenderType = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "RenderTypeNone"] = 0;
                        values[valuesById[1] = "RenderTypeSingle"] = 1;
                        values[valuesById[2] = "RenderTypeRotation"] = 2;
                        return values;
                    })();

                    v1.CheckBox = (function() {

                        /**
                         * Properties of a CheckBox.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface ICheckBox
                         * @property {string|null} [text] CheckBox text
                         * @property {bilibili.community.service.dm.v1.CheckboxType|null} [type] CheckBox type
                         * @property {boolean|null} [defaultValue] CheckBox defaultValue
                         * @property {boolean|null} [show] CheckBox show
                         */

                        /**
                         * Constructs a new CheckBox.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a CheckBox.
                         * @implements ICheckBox
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.ICheckBox=} [properties] Properties to set
                         */
                        function CheckBox(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * CheckBox text.
                         * @member {string} text
                         * @memberof bilibili.community.service.dm.v1.CheckBox
                         * @instance
                         */
                        CheckBox.prototype.text = "";

                        /**
                         * CheckBox type.
                         * @member {bilibili.community.service.dm.v1.CheckboxType} type
                         * @memberof bilibili.community.service.dm.v1.CheckBox
                         * @instance
                         */
                        CheckBox.prototype.type = 0;

                        /**
                         * CheckBox defaultValue.
                         * @member {boolean} defaultValue
                         * @memberof bilibili.community.service.dm.v1.CheckBox
                         * @instance
                         */
                        CheckBox.prototype.defaultValue = false;

                        /**
                         * CheckBox show.
                         * @member {boolean} show
                         * @memberof bilibili.community.service.dm.v1.CheckBox
                         * @instance
                         */
                        CheckBox.prototype.show = false;

                        /**
                         * Encodes the specified CheckBox message. Does not implicitly {@link bilibili.community.service.dm.v1.CheckBox.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.CheckBox
                         * @static
                         * @param {bilibili.community.service.dm.v1.ICheckBox} message CheckBox message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        CheckBox.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                                writer.uint32(/* id 1, wireType 2 =*/10).string(message.text);
                            if (message.type != null && Object.hasOwnProperty.call(message, "type"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.type);
                            if (message.defaultValue != null && Object.hasOwnProperty.call(message, "defaultValue"))
                                writer.uint32(/* id 3, wireType 0 =*/24).bool(message.defaultValue);
                            if (message.show != null && Object.hasOwnProperty.call(message, "show"))
                                writer.uint32(/* id 4, wireType 0 =*/32).bool(message.show);
                            return writer;
                        };

                        /**
                         * Decodes a CheckBox message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.CheckBox
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.CheckBox} CheckBox
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        CheckBox.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.CheckBox();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.text = reader.string();
                                        break;
                                    }
                                case 2: {
                                        message.type = reader.int32();
                                        break;
                                    }
                                case 3: {
                                        message.defaultValue = reader.bool();
                                        break;
                                    }
                                case 4: {
                                        message.show = reader.bool();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for CheckBox
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.CheckBox
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        CheckBox.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.CheckBox";
                        };

                        return CheckBox;
                    })();

                    v1.CheckBoxV2 = (function() {

                        /**
                         * Properties of a CheckBoxV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface ICheckBoxV2
                         * @property {string|null} [text] CheckBoxV2 text
                         * @property {bilibili.community.service.dm.v1.CheckboxType|null} [type] CheckBoxV2 type
                         * @property {boolean|null} [defaultValue] CheckBoxV2 defaultValue
                         */

                        /**
                         * Constructs a new CheckBoxV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a CheckBoxV2.
                         * @implements ICheckBoxV2
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.ICheckBoxV2=} [properties] Properties to set
                         */
                        function CheckBoxV2(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * CheckBoxV2 text.
                         * @member {string} text
                         * @memberof bilibili.community.service.dm.v1.CheckBoxV2
                         * @instance
                         */
                        CheckBoxV2.prototype.text = "";

                        /**
                         * CheckBoxV2 type.
                         * @member {bilibili.community.service.dm.v1.CheckboxType} type
                         * @memberof bilibili.community.service.dm.v1.CheckBoxV2
                         * @instance
                         */
                        CheckBoxV2.prototype.type = 0;

                        /**
                         * CheckBoxV2 defaultValue.
                         * @member {boolean} defaultValue
                         * @memberof bilibili.community.service.dm.v1.CheckBoxV2
                         * @instance
                         */
                        CheckBoxV2.prototype.defaultValue = false;

                        /**
                         * Encodes the specified CheckBoxV2 message. Does not implicitly {@link bilibili.community.service.dm.v1.CheckBoxV2.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.CheckBoxV2
                         * @static
                         * @param {bilibili.community.service.dm.v1.ICheckBoxV2} message CheckBoxV2 message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        CheckBoxV2.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                                writer.uint32(/* id 1, wireType 2 =*/10).string(message.text);
                            if (message.type != null && Object.hasOwnProperty.call(message, "type"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.type);
                            if (message.defaultValue != null && Object.hasOwnProperty.call(message, "defaultValue"))
                                writer.uint32(/* id 3, wireType 0 =*/24).bool(message.defaultValue);
                            return writer;
                        };

                        /**
                         * Decodes a CheckBoxV2 message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.CheckBoxV2
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.CheckBoxV2} CheckBoxV2
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        CheckBoxV2.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.CheckBoxV2();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.text = reader.string();
                                        break;
                                    }
                                case 2: {
                                        message.type = reader.int32();
                                        break;
                                    }
                                case 3: {
                                        message.defaultValue = reader.bool();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for CheckBoxV2
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.CheckBoxV2
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        CheckBoxV2.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.CheckBoxV2";
                        };

                        return CheckBoxV2;
                    })();

                    /**
                     * CheckboxType enum.
                     * @name bilibili.community.service.dm.v1.CheckboxType
                     * @enum {number}
                     * @property {number} CheckboxTypeNone=0 CheckboxTypeNone value
                     * @property {number} CheckboxTypeEncourage=1 CheckboxTypeEncourage value
                     */
                    v1.CheckboxType = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "CheckboxTypeNone"] = 0;
                        values[valuesById[1] = "CheckboxTypeEncourage"] = 1;
                        return values;
                    })();

                    v1.Toast = (function() {

                        /**
                         * Properties of a Toast.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IToast
                         * @property {string|null} [text] Toast text
                         * @property {number|null} [duration] Toast duration
                         * @property {boolean|null} [show] Toast show
                         * @property {bilibili.community.service.dm.v1.IButton|null} [button] Toast button
                         */

                        /**
                         * Constructs a new Toast.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a Toast.
                         * @implements IToast
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IToast=} [properties] Properties to set
                         */
                        function Toast(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * Toast text.
                         * @member {string} text
                         * @memberof bilibili.community.service.dm.v1.Toast
                         * @instance
                         */
                        Toast.prototype.text = "";

                        /**
                         * Toast duration.
                         * @member {number} duration
                         * @memberof bilibili.community.service.dm.v1.Toast
                         * @instance
                         */
                        Toast.prototype.duration = 0;

                        /**
                         * Toast show.
                         * @member {boolean} show
                         * @memberof bilibili.community.service.dm.v1.Toast
                         * @instance
                         */
                        Toast.prototype.show = false;

                        /**
                         * Toast button.
                         * @member {bilibili.community.service.dm.v1.IButton|null|undefined} button
                         * @memberof bilibili.community.service.dm.v1.Toast
                         * @instance
                         */
                        Toast.prototype.button = null;

                        /**
                         * Encodes the specified Toast message. Does not implicitly {@link bilibili.community.service.dm.v1.Toast.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.Toast
                         * @static
                         * @param {bilibili.community.service.dm.v1.IToast} message Toast message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        Toast.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                                writer.uint32(/* id 1, wireType 2 =*/10).string(message.text);
                            if (message.duration != null && Object.hasOwnProperty.call(message, "duration"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.duration);
                            if (message.show != null && Object.hasOwnProperty.call(message, "show"))
                                writer.uint32(/* id 3, wireType 0 =*/24).bool(message.show);
                            if (message.button != null && Object.hasOwnProperty.call(message, "button"))
                                $root.bilibili.community.service.dm.v1.Button.encode(message.button, writer.uint32(/* id 4, wireType 2 =*/34).fork()).ldelim();
                            return writer;
                        };

                        /**
                         * Decodes a Toast message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.Toast
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.Toast} Toast
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        Toast.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.Toast();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.text = reader.string();
                                        break;
                                    }
                                case 2: {
                                        message.duration = reader.int32();
                                        break;
                                    }
                                case 3: {
                                        message.show = reader.bool();
                                        break;
                                    }
                                case 4: {
                                        message.button = $root.bilibili.community.service.dm.v1.Button.decode(reader, reader.uint32());
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for Toast
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.Toast
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        Toast.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.Toast";
                        };

                        return Toast;
                    })();

                    v1.ToastV2 = (function() {

                        /**
                         * Properties of a ToastV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IToastV2
                         * @property {string|null} [text] ToastV2 text
                         * @property {number|null} [duration] ToastV2 duration
                         * @property {bilibili.community.service.dm.v1.IToastButtonV2|null} [toastButtonV2] ToastV2 toastButtonV2
                         */

                        /**
                         * Constructs a new ToastV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a ToastV2.
                         * @implements IToastV2
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IToastV2=} [properties] Properties to set
                         */
                        function ToastV2(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * ToastV2 text.
                         * @member {string} text
                         * @memberof bilibili.community.service.dm.v1.ToastV2
                         * @instance
                         */
                        ToastV2.prototype.text = "";

                        /**
                         * ToastV2 duration.
                         * @member {number} duration
                         * @memberof bilibili.community.service.dm.v1.ToastV2
                         * @instance
                         */
                        ToastV2.prototype.duration = 0;

                        /**
                         * ToastV2 toastButtonV2.
                         * @member {bilibili.community.service.dm.v1.IToastButtonV2|null|undefined} toastButtonV2
                         * @memberof bilibili.community.service.dm.v1.ToastV2
                         * @instance
                         */
                        ToastV2.prototype.toastButtonV2 = null;

                        /**
                         * Encodes the specified ToastV2 message. Does not implicitly {@link bilibili.community.service.dm.v1.ToastV2.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.ToastV2
                         * @static
                         * @param {bilibili.community.service.dm.v1.IToastV2} message ToastV2 message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        ToastV2.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                                writer.uint32(/* id 1, wireType 2 =*/10).string(message.text);
                            if (message.duration != null && Object.hasOwnProperty.call(message, "duration"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.duration);
                            if (message.toastButtonV2 != null && Object.hasOwnProperty.call(message, "toastButtonV2"))
                                $root.bilibili.community.service.dm.v1.ToastButtonV2.encode(message.toastButtonV2, writer.uint32(/* id 3, wireType 2 =*/26).fork()).ldelim();
                            return writer;
                        };

                        /**
                         * Decodes a ToastV2 message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.ToastV2
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.ToastV2} ToastV2
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        ToastV2.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.ToastV2();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.text = reader.string();
                                        break;
                                    }
                                case 2: {
                                        message.duration = reader.int32();
                                        break;
                                    }
                                case 3: {
                                        message.toastButtonV2 = $root.bilibili.community.service.dm.v1.ToastButtonV2.decode(reader, reader.uint32());
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for ToastV2
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.ToastV2
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        ToastV2.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.ToastV2";
                        };

                        return ToastV2;
                    })();

                    v1.BubbleV2 = (function() {

                        /**
                         * Properties of a BubbleV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IBubbleV2
                         * @property {string|null} [text] BubbleV2 text
                         * @property {string|null} [url] BubbleV2 url
                         * @property {bilibili.community.service.dm.v1.BubbleType|null} [bubbleType] BubbleV2 bubbleType
                         * @property {boolean|null} [exposureOnce] BubbleV2 exposureOnce
                         * @property {bilibili.community.service.dm.v1.ExposureType|null} [exposureType] BubbleV2 exposureType
                         */

                        /**
                         * Constructs a new BubbleV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a BubbleV2.
                         * @implements IBubbleV2
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IBubbleV2=} [properties] Properties to set
                         */
                        function BubbleV2(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * BubbleV2 text.
                         * @member {string} text
                         * @memberof bilibili.community.service.dm.v1.BubbleV2
                         * @instance
                         */
                        BubbleV2.prototype.text = "";

                        /**
                         * BubbleV2 url.
                         * @member {string} url
                         * @memberof bilibili.community.service.dm.v1.BubbleV2
                         * @instance
                         */
                        BubbleV2.prototype.url = "";

                        /**
                         * BubbleV2 bubbleType.
                         * @member {bilibili.community.service.dm.v1.BubbleType} bubbleType
                         * @memberof bilibili.community.service.dm.v1.BubbleV2
                         * @instance
                         */
                        BubbleV2.prototype.bubbleType = 0;

                        /**
                         * BubbleV2 exposureOnce.
                         * @member {boolean} exposureOnce
                         * @memberof bilibili.community.service.dm.v1.BubbleV2
                         * @instance
                         */
                        BubbleV2.prototype.exposureOnce = false;

                        /**
                         * BubbleV2 exposureType.
                         * @member {bilibili.community.service.dm.v1.ExposureType} exposureType
                         * @memberof bilibili.community.service.dm.v1.BubbleV2
                         * @instance
                         */
                        BubbleV2.prototype.exposureType = 0;

                        /**
                         * Encodes the specified BubbleV2 message. Does not implicitly {@link bilibili.community.service.dm.v1.BubbleV2.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.BubbleV2
                         * @static
                         * @param {bilibili.community.service.dm.v1.IBubbleV2} message BubbleV2 message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        BubbleV2.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                                writer.uint32(/* id 1, wireType 2 =*/10).string(message.text);
                            if (message.url != null && Object.hasOwnProperty.call(message, "url"))
                                writer.uint32(/* id 2, wireType 2 =*/18).string(message.url);
                            if (message.bubbleType != null && Object.hasOwnProperty.call(message, "bubbleType"))
                                writer.uint32(/* id 3, wireType 0 =*/24).int32(message.bubbleType);
                            if (message.exposureOnce != null && Object.hasOwnProperty.call(message, "exposureOnce"))
                                writer.uint32(/* id 4, wireType 0 =*/32).bool(message.exposureOnce);
                            if (message.exposureType != null && Object.hasOwnProperty.call(message, "exposureType"))
                                writer.uint32(/* id 5, wireType 0 =*/40).int32(message.exposureType);
                            return writer;
                        };

                        /**
                         * Decodes a BubbleV2 message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.BubbleV2
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.BubbleV2} BubbleV2
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        BubbleV2.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.BubbleV2();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.text = reader.string();
                                        break;
                                    }
                                case 2: {
                                        message.url = reader.string();
                                        break;
                                    }
                                case 3: {
                                        message.bubbleType = reader.int32();
                                        break;
                                    }
                                case 4: {
                                        message.exposureOnce = reader.bool();
                                        break;
                                    }
                                case 5: {
                                        message.exposureType = reader.int32();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for BubbleV2
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.BubbleV2
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        BubbleV2.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.BubbleV2";
                        };

                        return BubbleV2;
                    })();

                    /**
                     * BubbleType enum.
                     * @name bilibili.community.service.dm.v1.BubbleType
                     * @enum {number}
                     * @property {number} BubbleTypeNone=0 BubbleTypeNone value
                     * @property {number} BubbleTypeClickButton=1 BubbleTypeClickButton value
                     * @property {number} BubbleTypeDmSettingPanel=2 BubbleTypeDmSettingPanel value
                     */
                    v1.BubbleType = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "BubbleTypeNone"] = 0;
                        values[valuesById[1] = "BubbleTypeClickButton"] = 1;
                        values[valuesById[2] = "BubbleTypeDmSettingPanel"] = 2;
                        return values;
                    })();

                    v1.LabelV2 = (function() {

                        /**
                         * Properties of a LabelV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface ILabelV2
                         * @property {string|null} [title] LabelV2 title
                         * @property {Array.<string>|null} [content] LabelV2 content
                         * @property {boolean|null} [exposureOnce] LabelV2 exposureOnce
                         * @property {bilibili.community.service.dm.v1.ExposureType|null} [exposureType] LabelV2 exposureType
                         */

                        /**
                         * Constructs a new LabelV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a LabelV2.
                         * @implements ILabelV2
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.ILabelV2=} [properties] Properties to set
                         */
                        function LabelV2(properties) {
                            this.content = [];
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * LabelV2 title.
                         * @member {string} title
                         * @memberof bilibili.community.service.dm.v1.LabelV2
                         * @instance
                         */
                        LabelV2.prototype.title = "";

                        /**
                         * LabelV2 content.
                         * @member {Array.<string>} content
                         * @memberof bilibili.community.service.dm.v1.LabelV2
                         * @instance
                         */
                        LabelV2.prototype.content = $util.emptyArray;

                        /**
                         * LabelV2 exposureOnce.
                         * @member {boolean} exposureOnce
                         * @memberof bilibili.community.service.dm.v1.LabelV2
                         * @instance
                         */
                        LabelV2.prototype.exposureOnce = false;

                        /**
                         * LabelV2 exposureType.
                         * @member {bilibili.community.service.dm.v1.ExposureType} exposureType
                         * @memberof bilibili.community.service.dm.v1.LabelV2
                         * @instance
                         */
                        LabelV2.prototype.exposureType = 0;

                        /**
                         * Encodes the specified LabelV2 message. Does not implicitly {@link bilibili.community.service.dm.v1.LabelV2.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.LabelV2
                         * @static
                         * @param {bilibili.community.service.dm.v1.ILabelV2} message LabelV2 message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        LabelV2.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.title != null && Object.hasOwnProperty.call(message, "title"))
                                writer.uint32(/* id 1, wireType 2 =*/10).string(message.title);
                            if (message.content != null && message.content.length)
                                for (let i = 0; i < message.content.length; ++i)
                                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.content[i]);
                            if (message.exposureOnce != null && Object.hasOwnProperty.call(message, "exposureOnce"))
                                writer.uint32(/* id 3, wireType 0 =*/24).bool(message.exposureOnce);
                            if (message.exposureType != null && Object.hasOwnProperty.call(message, "exposureType"))
                                writer.uint32(/* id 4, wireType 0 =*/32).int32(message.exposureType);
                            return writer;
                        };

                        /**
                         * Decodes a LabelV2 message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.LabelV2
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.LabelV2} LabelV2
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        LabelV2.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.LabelV2();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.title = reader.string();
                                        break;
                                    }
                                case 2: {
                                        if (!(message.content && message.content.length))
                                            message.content = [];
                                        message.content.push(reader.string());
                                        break;
                                    }
                                case 3: {
                                        message.exposureOnce = reader.bool();
                                        break;
                                    }
                                case 4: {
                                        message.exposureType = reader.int32();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for LabelV2
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.LabelV2
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        LabelV2.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.LabelV2";
                        };

                        return LabelV2;
                    })();

                    /**
                     * ExposureType enum.
                     * @name bilibili.community.service.dm.v1.ExposureType
                     * @enum {number}
                     * @property {number} ExposureTypeNone=0 ExposureTypeNone value
                     * @property {number} ExposureTypeDMSend=1 ExposureTypeDMSend value
                     */
                    v1.ExposureType = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "ExposureTypeNone"] = 0;
                        values[valuesById[1] = "ExposureTypeDMSend"] = 1;
                        return values;
                    })();

                    v1.ToastButtonV2 = (function() {

                        /**
                         * Properties of a ToastButtonV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IToastButtonV2
                         * @property {string|null} [text] ToastButtonV2 text
                         * @property {bilibili.community.service.dm.v1.ToastFunctionType|null} [action] ToastButtonV2 action
                         */

                        /**
                         * Constructs a new ToastButtonV2.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a ToastButtonV2.
                         * @implements IToastButtonV2
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IToastButtonV2=} [properties] Properties to set
                         */
                        function ToastButtonV2(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * ToastButtonV2 text.
                         * @member {string} text
                         * @memberof bilibili.community.service.dm.v1.ToastButtonV2
                         * @instance
                         */
                        ToastButtonV2.prototype.text = "";

                        /**
                         * ToastButtonV2 action.
                         * @member {bilibili.community.service.dm.v1.ToastFunctionType} action
                         * @memberof bilibili.community.service.dm.v1.ToastButtonV2
                         * @instance
                         */
                        ToastButtonV2.prototype.action = 0;

                        /**
                         * Encodes the specified ToastButtonV2 message. Does not implicitly {@link bilibili.community.service.dm.v1.ToastButtonV2.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.ToastButtonV2
                         * @static
                         * @param {bilibili.community.service.dm.v1.IToastButtonV2} message ToastButtonV2 message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        ToastButtonV2.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                                writer.uint32(/* id 1, wireType 2 =*/10).string(message.text);
                            if (message.action != null && Object.hasOwnProperty.call(message, "action"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.action);
                            return writer;
                        };

                        /**
                         * Decodes a ToastButtonV2 message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.ToastButtonV2
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.ToastButtonV2} ToastButtonV2
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        ToastButtonV2.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.ToastButtonV2();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.text = reader.string();
                                        break;
                                    }
                                case 2: {
                                        message.action = reader.int32();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for ToastButtonV2
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.ToastButtonV2
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        ToastButtonV2.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.ToastButtonV2";
                        };

                        return ToastButtonV2;
                    })();

                    v1.Button = (function() {

                        /**
                         * Properties of a Button.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IButton
                         * @property {string|null} [text] Button text
                         * @property {bilibili.community.service.dm.v1.ToastFunctionType|null} [action] Button action
                         */

                        /**
                         * Constructs a new Button.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a Button.
                         * @implements IButton
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IButton=} [properties] Properties to set
                         */
                        function Button(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * Button text.
                         * @member {string} text
                         * @memberof bilibili.community.service.dm.v1.Button
                         * @instance
                         */
                        Button.prototype.text = "";

                        /**
                         * Button action.
                         * @member {bilibili.community.service.dm.v1.ToastFunctionType} action
                         * @memberof bilibili.community.service.dm.v1.Button
                         * @instance
                         */
                        Button.prototype.action = 0;

                        /**
                         * Encodes the specified Button message. Does not implicitly {@link bilibili.community.service.dm.v1.Button.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.Button
                         * @static
                         * @param {bilibili.community.service.dm.v1.IButton} message Button message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        Button.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                                writer.uint32(/* id 1, wireType 2 =*/10).string(message.text);
                            if (message.action != null && Object.hasOwnProperty.call(message, "action"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.action);
                            return writer;
                        };

                        /**
                         * Decodes a Button message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.Button
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.Button} Button
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        Button.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.Button();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.text = reader.string();
                                        break;
                                    }
                                case 2: {
                                        message.action = reader.int32();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for Button
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.Button
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        Button.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.Button";
                        };

                        return Button;
                    })();

                    /**
                     * ToastFunctionType enum.
                     * @name bilibili.community.service.dm.v1.ToastFunctionType
                     * @enum {number}
                     * @property {number} ToastFunctionTypeNone=0 ToastFunctionTypeNone value
                     * @property {number} ToastFunctionTypePostPanel=1 ToastFunctionTypePostPanel value
                     */
                    v1.ToastFunctionType = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "ToastFunctionTypeNone"] = 0;
                        values[valuesById[1] = "ToastFunctionTypePostPanel"] = 1;
                        return values;
                    })();

                    /**
                     * ToastBizType enum.
                     * @name bilibili.community.service.dm.v1.ToastBizType
                     * @enum {number}
                     * @property {number} ToastBizTypeNone=0 ToastBizTypeNone value
                     * @property {number} ToastBizTypeEncourage=1 ToastBizTypeEncourage value
                     */
                    v1.ToastBizType = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "ToastBizTypeNone"] = 0;
                        values[valuesById[1] = "ToastBizTypeEncourage"] = 1;
                        return values;
                    })();

                    v1.CommandDm = (function() {

                        /**
                         * Properties of a CommandDm.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface ICommandDm
                         * @property {number|null} [oid] CommandDm oid
                         * @property {number|null} [mid] CommandDm mid
                         * @property {string|null} [command] CommandDm command
                         * @property {string|null} [text] CommandDm text
                         * @property {number|null} [stime] CommandDm stime
                         * @property {string|null} [ctime] CommandDm ctime
                         * @property {string|null} [mtime] CommandDm mtime
                         * @property {string|null} [extra] CommandDm extra
                         * @property {string|null} [dmid] CommandDm dmid
                         */

                        /**
                         * Constructs a new CommandDm.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a CommandDm.
                         * @implements ICommandDm
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.ICommandDm=} [properties] Properties to set
                         */
                        function CommandDm(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * CommandDm oid.
                         * @member {number} oid
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @instance
                         */
                        CommandDm.prototype.oid = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * CommandDm mid.
                         * @member {number} mid
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @instance
                         */
                        CommandDm.prototype.mid = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * CommandDm command.
                         * @member {string} command
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @instance
                         */
                        CommandDm.prototype.command = "";

                        /**
                         * CommandDm text.
                         * @member {string} text
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @instance
                         */
                        CommandDm.prototype.text = "";

                        /**
                         * CommandDm stime.
                         * @member {number} stime
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @instance
                         */
                        CommandDm.prototype.stime = 0;

                        /**
                         * CommandDm ctime.
                         * @member {string} ctime
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @instance
                         */
                        CommandDm.prototype.ctime = "";

                        /**
                         * CommandDm mtime.
                         * @member {string} mtime
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @instance
                         */
                        CommandDm.prototype.mtime = "";

                        /**
                         * CommandDm extra.
                         * @member {string} extra
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @instance
                         */
                        CommandDm.prototype.extra = "";

                        /**
                         * CommandDm dmid.
                         * @member {string} dmid
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @instance
                         */
                        CommandDm.prototype.dmid = "";

                        /**
                         * Encodes the specified CommandDm message. Does not implicitly {@link bilibili.community.service.dm.v1.CommandDm.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @static
                         * @param {bilibili.community.service.dm.v1.ICommandDm} message CommandDm message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        CommandDm.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.oid != null && Object.hasOwnProperty.call(message, "oid"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int64(message.oid);
                            if (message.mid != null && Object.hasOwnProperty.call(message, "mid"))
                                writer.uint32(/* id 3, wireType 0 =*/24).int64(message.mid);
                            if (message.command != null && Object.hasOwnProperty.call(message, "command"))
                                writer.uint32(/* id 4, wireType 2 =*/34).string(message.command);
                            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                                writer.uint32(/* id 5, wireType 2 =*/42).string(message.text);
                            if (message.stime != null && Object.hasOwnProperty.call(message, "stime"))
                                writer.uint32(/* id 6, wireType 0 =*/48).int32(message.stime);
                            if (message.ctime != null && Object.hasOwnProperty.call(message, "ctime"))
                                writer.uint32(/* id 7, wireType 2 =*/58).string(message.ctime);
                            if (message.mtime != null && Object.hasOwnProperty.call(message, "mtime"))
                                writer.uint32(/* id 8, wireType 2 =*/66).string(message.mtime);
                            if (message.extra != null && Object.hasOwnProperty.call(message, "extra"))
                                writer.uint32(/* id 9, wireType 2 =*/74).string(message.extra);
                            if (message.dmid != null && Object.hasOwnProperty.call(message, "dmid"))
                                writer.uint32(/* id 10, wireType 2 =*/82).string(message.dmid);
                            return writer;
                        };

                        /**
                         * Decodes a CommandDm message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.CommandDm} CommandDm
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        CommandDm.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.CommandDm();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 2: {
                                        message.oid = reader.int64();
                                        break;
                                    }
                                case 3: {
                                        message.mid = reader.int64();
                                        break;
                                    }
                                case 4: {
                                        message.command = reader.string();
                                        break;
                                    }
                                case 5: {
                                        message.text = reader.string();
                                        break;
                                    }
                                case 6: {
                                        message.stime = reader.int32();
                                        break;
                                    }
                                case 7: {
                                        message.ctime = reader.string();
                                        break;
                                    }
                                case 8: {
                                        message.mtime = reader.string();
                                        break;
                                    }
                                case 9: {
                                        message.extra = reader.string();
                                        break;
                                    }
                                case 10: {
                                        message.dmid = reader.string();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for CommandDm
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.CommandDm
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        CommandDm.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.CommandDm";
                        };

                        return CommandDm;
                    })();

                    v1.DmSegConfig = (function() {

                        /**
                         * Properties of a DmSegConfig.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IDmSegConfig
                         * @property {number|null} [pageSize] DmSegConfig pageSize
                         * @property {number|null} [total] DmSegConfig total
                         */

                        /**
                         * Constructs a new DmSegConfig.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a DmSegConfig.
                         * @implements IDmSegConfig
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IDmSegConfig=} [properties] Properties to set
                         */
                        function DmSegConfig(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * DmSegConfig pageSize.
                         * @member {number} pageSize
                         * @memberof bilibili.community.service.dm.v1.DmSegConfig
                         * @instance
                         */
                        DmSegConfig.prototype.pageSize = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * DmSegConfig total.
                         * @member {number} total
                         * @memberof bilibili.community.service.dm.v1.DmSegConfig
                         * @instance
                         */
                        DmSegConfig.prototype.total = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * Encodes the specified DmSegConfig message. Does not implicitly {@link bilibili.community.service.dm.v1.DmSegConfig.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.DmSegConfig
                         * @static
                         * @param {bilibili.community.service.dm.v1.IDmSegConfig} message DmSegConfig message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        DmSegConfig.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.pageSize != null && Object.hasOwnProperty.call(message, "pageSize"))
                                writer.uint32(/* id 1, wireType 0 =*/8).int64(message.pageSize);
                            if (message.total != null && Object.hasOwnProperty.call(message, "total"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int64(message.total);
                            return writer;
                        };

                        /**
                         * Decodes a DmSegConfig message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.DmSegConfig
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.DmSegConfig} DmSegConfig
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        DmSegConfig.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.DmSegConfig();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.pageSize = reader.int64();
                                        break;
                                    }
                                case 2: {
                                        message.total = reader.int64();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for DmSegConfig
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.DmSegConfig
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        DmSegConfig.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.DmSegConfig";
                        };

                        return DmSegConfig;
                    })();

                    v1.DanmakuFlagConfig = (function() {

                        /**
                         * Properties of a DanmakuFlagConfig.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IDanmakuFlagConfig
                         * @property {number|null} [recFlag] DanmakuFlagConfig recFlag
                         * @property {string|null} [recText] DanmakuFlagConfig recText
                         * @property {number|null} [recSwitch] DanmakuFlagConfig recSwitch
                         */

                        /**
                         * Constructs a new DanmakuFlagConfig.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a DanmakuFlagConfig.
                         * @implements IDanmakuFlagConfig
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IDanmakuFlagConfig=} [properties] Properties to set
                         */
                        function DanmakuFlagConfig(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * DanmakuFlagConfig recFlag.
                         * @member {number} recFlag
                         * @memberof bilibili.community.service.dm.v1.DanmakuFlagConfig
                         * @instance
                         */
                        DanmakuFlagConfig.prototype.recFlag = 0;

                        /**
                         * DanmakuFlagConfig recText.
                         * @member {string} recText
                         * @memberof bilibili.community.service.dm.v1.DanmakuFlagConfig
                         * @instance
                         */
                        DanmakuFlagConfig.prototype.recText = "";

                        /**
                         * DanmakuFlagConfig recSwitch.
                         * @member {number} recSwitch
                         * @memberof bilibili.community.service.dm.v1.DanmakuFlagConfig
                         * @instance
                         */
                        DanmakuFlagConfig.prototype.recSwitch = 0;

                        /**
                         * Encodes the specified DanmakuFlagConfig message. Does not implicitly {@link bilibili.community.service.dm.v1.DanmakuFlagConfig.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.DanmakuFlagConfig
                         * @static
                         * @param {bilibili.community.service.dm.v1.IDanmakuFlagConfig} message DanmakuFlagConfig message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        DanmakuFlagConfig.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.recFlag != null && Object.hasOwnProperty.call(message, "recFlag"))
                                writer.uint32(/* id 1, wireType 0 =*/8).int32(message.recFlag);
                            if (message.recText != null && Object.hasOwnProperty.call(message, "recText"))
                                writer.uint32(/* id 2, wireType 2 =*/18).string(message.recText);
                            if (message.recSwitch != null && Object.hasOwnProperty.call(message, "recSwitch"))
                                writer.uint32(/* id 3, wireType 0 =*/24).int32(message.recSwitch);
                            return writer;
                        };

                        /**
                         * Decodes a DanmakuFlagConfig message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.DanmakuFlagConfig
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.DanmakuFlagConfig} DanmakuFlagConfig
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        DanmakuFlagConfig.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.DanmakuFlagConfig();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.recFlag = reader.int32();
                                        break;
                                    }
                                case 2: {
                                        message.recText = reader.string();
                                        break;
                                    }
                                case 3: {
                                        message.recSwitch = reader.int32();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for DanmakuFlagConfig
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.DanmakuFlagConfig
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        DanmakuFlagConfig.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.DanmakuFlagConfig";
                        };

                        return DanmakuFlagConfig;
                    })();

                    v1.DmSegMobileReply = (function() {

                        /**
                         * Properties of a DmSegMobileReply.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IDmSegMobileReply
                         * @property {Array.<bilibili.community.service.dm.v1.IDanmakuElem>|null} [elems] DmSegMobileReply elems
                         * @property {Array.<bilibili.community.service.dm.v1.IDmColorful>|null} [colorfulSrc] DmSegMobileReply colorfulSrc
                         */

                        /**
                         * Constructs a new DmSegMobileReply.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a DmSegMobileReply.
                         * @implements IDmSegMobileReply
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IDmSegMobileReply=} [properties] Properties to set
                         */
                        function DmSegMobileReply(properties) {
                            this.elems = [];
                            this.colorfulSrc = [];
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * DmSegMobileReply elems.
                         * @member {Array.<bilibili.community.service.dm.v1.IDanmakuElem>} elems
                         * @memberof bilibili.community.service.dm.v1.DmSegMobileReply
                         * @instance
                         */
                        DmSegMobileReply.prototype.elems = $util.emptyArray;

                        /**
                         * DmSegMobileReply colorfulSrc.
                         * @member {Array.<bilibili.community.service.dm.v1.IDmColorful>} colorfulSrc
                         * @memberof bilibili.community.service.dm.v1.DmSegMobileReply
                         * @instance
                         */
                        DmSegMobileReply.prototype.colorfulSrc = $util.emptyArray;

                        /**
                         * Encodes the specified DmSegMobileReply message. Does not implicitly {@link bilibili.community.service.dm.v1.DmSegMobileReply.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.DmSegMobileReply
                         * @static
                         * @param {bilibili.community.service.dm.v1.IDmSegMobileReply} message DmSegMobileReply message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        DmSegMobileReply.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.elems != null && message.elems.length)
                                for (let i = 0; i < message.elems.length; ++i)
                                    $root.bilibili.community.service.dm.v1.DanmakuElem.encode(message.elems[i], writer.uint32(/* id 1, wireType 2 =*/10).fork()).ldelim();
                            if (message.colorfulSrc != null && message.colorfulSrc.length)
                                for (let i = 0; i < message.colorfulSrc.length; ++i)
                                    $root.bilibili.community.service.dm.v1.DmColorful.encode(message.colorfulSrc[i], writer.uint32(/* id 5, wireType 2 =*/42).fork()).ldelim();
                            return writer;
                        };

                        /**
                         * Decodes a DmSegMobileReply message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.DmSegMobileReply
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.DmSegMobileReply} DmSegMobileReply
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        DmSegMobileReply.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.DmSegMobileReply();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        if (!(message.elems && message.elems.length))
                                            message.elems = [];
                                        message.elems.push($root.bilibili.community.service.dm.v1.DanmakuElem.decode(reader, reader.uint32()));
                                        break;
                                    }
                                case 5: {
                                        if (!(message.colorfulSrc && message.colorfulSrc.length))
                                            message.colorfulSrc = [];
                                        message.colorfulSrc.push($root.bilibili.community.service.dm.v1.DmColorful.decode(reader, reader.uint32()));
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for DmSegMobileReply
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.DmSegMobileReply
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        DmSegMobileReply.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.DmSegMobileReply";
                        };

                        return DmSegMobileReply;
                    })();

                    v1.DanmakuElem = (function() {

                        /**
                         * Properties of a DanmakuElem.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IDanmakuElem
                         * @property {number|null} [stime] DanmakuElem stime
                         * @property {number|null} [mode] DanmakuElem mode
                         * @property {number|null} [size] DanmakuElem size
                         * @property {number|null} [color] DanmakuElem color
                         * @property {string|null} [uhash] DanmakuElem uhash
                         * @property {string|null} [text] DanmakuElem text
                         * @property {number|null} [date] DanmakuElem date
                         * @property {number|null} [weight] DanmakuElem weight
                         * @property {string|null} [action] DanmakuElem action
                         * @property {number|null} [pool] DanmakuElem pool
                         * @property {string|null} [dmid] DanmakuElem dmid
                         * @property {number|null} [attr] DanmakuElem attr
                         * @property {string|null} [animation] DanmakuElem animation
                         * @property {bilibili.community.service.dm.v1.DmColorfulType|null} [colorful] DanmakuElem colorful
                         * @property {number|null} [oid] DanmakuElem oid
                         * @property {bilibili.community.service.dm.v1.DmFromType|null} [dmFrom] DanmakuElem dmFrom
                         */

                        /**
                         * Constructs a new DanmakuElem.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a DanmakuElem.
                         * @implements IDanmakuElem
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IDanmakuElem=} [properties] Properties to set
                         */
                        function DanmakuElem(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * DanmakuElem stime.
                         * @member {number} stime
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.stime = 0;

                        /**
                         * DanmakuElem mode.
                         * @member {number} mode
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.mode = 0;

                        /**
                         * DanmakuElem size.
                         * @member {number} size
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.size = 0;

                        /**
                         * DanmakuElem color.
                         * @member {number} color
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.color = 0;

                        /**
                         * DanmakuElem uhash.
                         * @member {string} uhash
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.uhash = "";

                        /**
                         * DanmakuElem text.
                         * @member {string} text
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.text = "";

                        /**
                         * DanmakuElem date.
                         * @member {number} date
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.date = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * DanmakuElem weight.
                         * @member {number} weight
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.weight = 0;

                        /**
                         * DanmakuElem action.
                         * @member {string} action
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.action = "";

                        /**
                         * DanmakuElem pool.
                         * @member {number} pool
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.pool = 0;

                        /**
                         * DanmakuElem dmid.
                         * @member {string} dmid
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.dmid = "";

                        /**
                         * DanmakuElem attr.
                         * @member {number} attr
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.attr = 0;

                        /**
                         * DanmakuElem animation.
                         * @member {string} animation
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.animation = "";

                        /**
                         * DanmakuElem colorful.
                         * @member {bilibili.community.service.dm.v1.DmColorfulType} colorful
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.colorful = 0;

                        /**
                         * DanmakuElem oid.
                         * @member {number} oid
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.oid = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * DanmakuElem dmFrom.
                         * @member {bilibili.community.service.dm.v1.DmFromType} dmFrom
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @instance
                         */
                        DanmakuElem.prototype.dmFrom = 0;

                        /**
                         * Encodes the specified DanmakuElem message. Does not implicitly {@link bilibili.community.service.dm.v1.DanmakuElem.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @static
                         * @param {bilibili.community.service.dm.v1.IDanmakuElem} message DanmakuElem message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        DanmakuElem.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.stime != null && Object.hasOwnProperty.call(message, "stime"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.stime);
                            if (message.mode != null && Object.hasOwnProperty.call(message, "mode"))
                                writer.uint32(/* id 3, wireType 0 =*/24).int32(message.mode);
                            if (message.size != null && Object.hasOwnProperty.call(message, "size"))
                                writer.uint32(/* id 4, wireType 0 =*/32).int32(message.size);
                            if (message.color != null && Object.hasOwnProperty.call(message, "color"))
                                writer.uint32(/* id 5, wireType 0 =*/40).uint32(message.color);
                            if (message.uhash != null && Object.hasOwnProperty.call(message, "uhash"))
                                writer.uint32(/* id 6, wireType 2 =*/50).string(message.uhash);
                            if (message.text != null && Object.hasOwnProperty.call(message, "text"))
                                writer.uint32(/* id 7, wireType 2 =*/58).string(message.text);
                            if (message.date != null && Object.hasOwnProperty.call(message, "date"))
                                writer.uint32(/* id 8, wireType 0 =*/64).int64(message.date);
                            if (message.weight != null && Object.hasOwnProperty.call(message, "weight"))
                                writer.uint32(/* id 9, wireType 0 =*/72).int32(message.weight);
                            if (message.action != null && Object.hasOwnProperty.call(message, "action"))
                                writer.uint32(/* id 10, wireType 2 =*/82).string(message.action);
                            if (message.pool != null && Object.hasOwnProperty.call(message, "pool"))
                                writer.uint32(/* id 11, wireType 0 =*/88).int32(message.pool);
                            if (message.dmid != null && Object.hasOwnProperty.call(message, "dmid"))
                                writer.uint32(/* id 12, wireType 2 =*/98).string(message.dmid);
                            if (message.attr != null && Object.hasOwnProperty.call(message, "attr"))
                                writer.uint32(/* id 13, wireType 0 =*/104).int32(message.attr);
                            if (message.animation != null && Object.hasOwnProperty.call(message, "animation"))
                                writer.uint32(/* id 22, wireType 2 =*/178).string(message.animation);
                            if (message.colorful != null && Object.hasOwnProperty.call(message, "colorful"))
                                writer.uint32(/* id 24, wireType 0 =*/192).int32(message.colorful);
                            if (message.oid != null && Object.hasOwnProperty.call(message, "oid"))
                                writer.uint32(/* id 26, wireType 0 =*/208).int64(message.oid);
                            if (message.dmFrom != null && Object.hasOwnProperty.call(message, "dmFrom"))
                                writer.uint32(/* id 27, wireType 0 =*/216).int32(message.dmFrom);
                            return writer;
                        };

                        /**
                         * Decodes a DanmakuElem message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.DanmakuElem} DanmakuElem
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        DanmakuElem.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.DanmakuElem();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 2: {
                                        message.stime = reader.int32();
                                        break;
                                    }
                                case 3: {
                                        message.mode = reader.int32();
                                        break;
                                    }
                                case 4: {
                                        message.size = reader.int32();
                                        break;
                                    }
                                case 5: {
                                        message.color = reader.uint32();
                                        break;
                                    }
                                case 6: {
                                        message.uhash = reader.string();
                                        break;
                                    }
                                case 7: {
                                        message.text = reader.string();
                                        break;
                                    }
                                case 8: {
                                        message.date = reader.int64();
                                        break;
                                    }
                                case 9: {
                                        message.weight = reader.int32();
                                        break;
                                    }
                                case 10: {
                                        message.action = reader.string();
                                        break;
                                    }
                                case 11: {
                                        message.pool = reader.int32();
                                        break;
                                    }
                                case 12: {
                                        message.dmid = reader.string();
                                        break;
                                    }
                                case 13: {
                                        message.attr = reader.int32();
                                        break;
                                    }
                                case 22: {
                                        message.animation = reader.string();
                                        break;
                                    }
                                case 24: {
                                        message.colorful = reader.int32();
                                        break;
                                    }
                                case 26: {
                                        message.oid = reader.int64();
                                        break;
                                    }
                                case 27: {
                                        message.dmFrom = reader.int32();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for DanmakuElem
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.DanmakuElem
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        DanmakuElem.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.DanmakuElem";
                        };

                        return DanmakuElem;
                    })();

                    /**
                     * DmFromType enum.
                     * @name bilibili.community.service.dm.v1.DmFromType
                     * @enum {number}
                     * @property {number} DmFromUnknown=0 DmFromUnknown value
                     * @property {number} DmFromNormal=1 DmFromNormal value
                     * @property {number} DmFromCmd=2 DmFromCmd value
                     * @property {number} DmFromLive=3 DmFromLive value
                     */
                    v1.DmFromType = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "DmFromUnknown"] = 0;
                        values[valuesById[1] = "DmFromNormal"] = 1;
                        values[valuesById[2] = "DmFromCmd"] = 2;
                        values[valuesById[3] = "DmFromLive"] = 3;
                        return values;
                    })();

                    v1.DanmuWebPlayerConfig = (function() {

                        /**
                         * Properties of a DanmuWebPlayerConfig.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IDanmuWebPlayerConfig
                         * @property {boolean|null} [dmSwitch] DanmuWebPlayerConfig dmSwitch
                         * @property {boolean|null} [aiSwitch] DanmuWebPlayerConfig aiSwitch
                         * @property {number|null} [aiLevel] DanmuWebPlayerConfig aiLevel
                         * @property {boolean|null} [typeTop] DanmuWebPlayerConfig typeTop
                         * @property {boolean|null} [typeScroll] DanmuWebPlayerConfig typeScroll
                         * @property {boolean|null} [typeBottom] DanmuWebPlayerConfig typeBottom
                         * @property {boolean|null} [typeColor] DanmuWebPlayerConfig typeColor
                         * @property {boolean|null} [typeSpecial] DanmuWebPlayerConfig typeSpecial
                         * @property {boolean|null} [preventshade] DanmuWebPlayerConfig preventshade
                         * @property {boolean|null} [dmask] DanmuWebPlayerConfig dmask
                         * @property {number|null} [opacity] DanmuWebPlayerConfig opacity
                         * @property {number|null} [speedplus] DanmuWebPlayerConfig speedplus
                         * @property {number|null} [fontsize] DanmuWebPlayerConfig fontsize
                         * @property {boolean|null} [fullscreensync] DanmuWebPlayerConfig fullscreensync
                         * @property {boolean|null} [speedsync] DanmuWebPlayerConfig speedsync
                         * @property {string|null} [fontfamily] DanmuWebPlayerConfig fontfamily
                         * @property {boolean|null} [bold] DanmuWebPlayerConfig bold
                         * @property {number|null} [fontborder] DanmuWebPlayerConfig fontborder
                         * @property {number|null} [seniorModeSwitch] DanmuWebPlayerConfig seniorModeSwitch
                         * @property {boolean|null} [typeTopBottom] DanmuWebPlayerConfig typeTopBottom
                         * @property {number|null} [dmarea] DanmuWebPlayerConfig dmarea
                         * @property {number|null} [dmdensity] DanmuWebPlayerConfig dmdensity
                         */

                        /**
                         * Constructs a new DanmuWebPlayerConfig.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a DanmuWebPlayerConfig.
                         * @implements IDanmuWebPlayerConfig
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IDanmuWebPlayerConfig=} [properties] Properties to set
                         */
                        function DanmuWebPlayerConfig(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * DanmuWebPlayerConfig dmSwitch.
                         * @member {boolean} dmSwitch
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.dmSwitch = false;

                        /**
                         * DanmuWebPlayerConfig aiSwitch.
                         * @member {boolean} aiSwitch
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.aiSwitch = false;

                        /**
                         * DanmuWebPlayerConfig aiLevel.
                         * @member {number} aiLevel
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.aiLevel = 0;

                        /**
                         * DanmuWebPlayerConfig typeTop.
                         * @member {boolean} typeTop
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.typeTop = false;

                        /**
                         * DanmuWebPlayerConfig typeScroll.
                         * @member {boolean} typeScroll
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.typeScroll = false;

                        /**
                         * DanmuWebPlayerConfig typeBottom.
                         * @member {boolean} typeBottom
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.typeBottom = false;

                        /**
                         * DanmuWebPlayerConfig typeColor.
                         * @member {boolean} typeColor
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.typeColor = false;

                        /**
                         * DanmuWebPlayerConfig typeSpecial.
                         * @member {boolean} typeSpecial
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.typeSpecial = false;

                        /**
                         * DanmuWebPlayerConfig preventshade.
                         * @member {boolean} preventshade
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.preventshade = false;

                        /**
                         * DanmuWebPlayerConfig dmask.
                         * @member {boolean} dmask
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.dmask = false;

                        /**
                         * DanmuWebPlayerConfig opacity.
                         * @member {number} opacity
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.opacity = 0;

                        /**
                         * DanmuWebPlayerConfig speedplus.
                         * @member {number} speedplus
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.speedplus = 0;

                        /**
                         * DanmuWebPlayerConfig fontsize.
                         * @member {number} fontsize
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.fontsize = 0;

                        /**
                         * DanmuWebPlayerConfig fullscreensync.
                         * @member {boolean} fullscreensync
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.fullscreensync = false;

                        /**
                         * DanmuWebPlayerConfig speedsync.
                         * @member {boolean} speedsync
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.speedsync = false;

                        /**
                         * DanmuWebPlayerConfig fontfamily.
                         * @member {string} fontfamily
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.fontfamily = "";

                        /**
                         * DanmuWebPlayerConfig bold.
                         * @member {boolean} bold
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.bold = false;

                        /**
                         * DanmuWebPlayerConfig fontborder.
                         * @member {number} fontborder
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.fontborder = 0;

                        /**
                         * DanmuWebPlayerConfig seniorModeSwitch.
                         * @member {number} seniorModeSwitch
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.seniorModeSwitch = 0;

                        /**
                         * DanmuWebPlayerConfig typeTopBottom.
                         * @member {boolean} typeTopBottom
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.typeTopBottom = false;

                        /**
                         * DanmuWebPlayerConfig dmarea.
                         * @member {number} dmarea
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.dmarea = 0;

                        /**
                         * DanmuWebPlayerConfig dmdensity.
                         * @member {number} dmdensity
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @instance
                         */
                        DanmuWebPlayerConfig.prototype.dmdensity = 0;

                        /**
                         * Encodes the specified DanmuWebPlayerConfig message. Does not implicitly {@link bilibili.community.service.dm.v1.DanmuWebPlayerConfig.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @static
                         * @param {bilibili.community.service.dm.v1.IDanmuWebPlayerConfig} message DanmuWebPlayerConfig message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        DanmuWebPlayerConfig.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.dmSwitch != null && Object.hasOwnProperty.call(message, "dmSwitch"))
                                writer.uint32(/* id 1, wireType 0 =*/8).bool(message.dmSwitch);
                            if (message.aiSwitch != null && Object.hasOwnProperty.call(message, "aiSwitch"))
                                writer.uint32(/* id 2, wireType 0 =*/16).bool(message.aiSwitch);
                            if (message.aiLevel != null && Object.hasOwnProperty.call(message, "aiLevel"))
                                writer.uint32(/* id 3, wireType 0 =*/24).int32(message.aiLevel);
                            if (message.typeTop != null && Object.hasOwnProperty.call(message, "typeTop"))
                                writer.uint32(/* id 4, wireType 0 =*/32).bool(message.typeTop);
                            if (message.typeScroll != null && Object.hasOwnProperty.call(message, "typeScroll"))
                                writer.uint32(/* id 5, wireType 0 =*/40).bool(message.typeScroll);
                            if (message.typeBottom != null && Object.hasOwnProperty.call(message, "typeBottom"))
                                writer.uint32(/* id 6, wireType 0 =*/48).bool(message.typeBottom);
                            if (message.typeColor != null && Object.hasOwnProperty.call(message, "typeColor"))
                                writer.uint32(/* id 7, wireType 0 =*/56).bool(message.typeColor);
                            if (message.typeSpecial != null && Object.hasOwnProperty.call(message, "typeSpecial"))
                                writer.uint32(/* id 8, wireType 0 =*/64).bool(message.typeSpecial);
                            if (message.preventshade != null && Object.hasOwnProperty.call(message, "preventshade"))
                                writer.uint32(/* id 9, wireType 0 =*/72).bool(message.preventshade);
                            if (message.dmask != null && Object.hasOwnProperty.call(message, "dmask"))
                                writer.uint32(/* id 10, wireType 0 =*/80).bool(message.dmask);
                            if (message.opacity != null && Object.hasOwnProperty.call(message, "opacity"))
                                writer.uint32(/* id 11, wireType 5 =*/93).float(message.opacity);
                            if (message.speedplus != null && Object.hasOwnProperty.call(message, "speedplus"))
                                writer.uint32(/* id 13, wireType 5 =*/109).float(message.speedplus);
                            if (message.fontsize != null && Object.hasOwnProperty.call(message, "fontsize"))
                                writer.uint32(/* id 14, wireType 5 =*/117).float(message.fontsize);
                            if (message.fullscreensync != null && Object.hasOwnProperty.call(message, "fullscreensync"))
                                writer.uint32(/* id 15, wireType 0 =*/120).bool(message.fullscreensync);
                            if (message.speedsync != null && Object.hasOwnProperty.call(message, "speedsync"))
                                writer.uint32(/* id 16, wireType 0 =*/128).bool(message.speedsync);
                            if (message.fontfamily != null && Object.hasOwnProperty.call(message, "fontfamily"))
                                writer.uint32(/* id 17, wireType 2 =*/138).string(message.fontfamily);
                            if (message.bold != null && Object.hasOwnProperty.call(message, "bold"))
                                writer.uint32(/* id 18, wireType 0 =*/144).bool(message.bold);
                            if (message.fontborder != null && Object.hasOwnProperty.call(message, "fontborder"))
                                writer.uint32(/* id 19, wireType 0 =*/152).int32(message.fontborder);
                            if (message.seniorModeSwitch != null && Object.hasOwnProperty.call(message, "seniorModeSwitch"))
                                writer.uint32(/* id 21, wireType 0 =*/168).int32(message.seniorModeSwitch);
                            if (message.typeTopBottom != null && Object.hasOwnProperty.call(message, "typeTopBottom"))
                                writer.uint32(/* id 24, wireType 0 =*/192).bool(message.typeTopBottom);
                            if (message.dmarea != null && Object.hasOwnProperty.call(message, "dmarea"))
                                writer.uint32(/* id 25, wireType 0 =*/200).int32(message.dmarea);
                            if (message.dmdensity != null && Object.hasOwnProperty.call(message, "dmdensity"))
                                writer.uint32(/* id 26, wireType 0 =*/208).int32(message.dmdensity);
                            return writer;
                        };

                        /**
                         * Decodes a DanmuWebPlayerConfig message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.DanmuWebPlayerConfig} DanmuWebPlayerConfig
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        DanmuWebPlayerConfig.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.DanmuWebPlayerConfig();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.dmSwitch = reader.bool();
                                        break;
                                    }
                                case 2: {
                                        message.aiSwitch = reader.bool();
                                        break;
                                    }
                                case 3: {
                                        message.aiLevel = reader.int32();
                                        break;
                                    }
                                case 4: {
                                        message.typeTop = reader.bool();
                                        break;
                                    }
                                case 5: {
                                        message.typeScroll = reader.bool();
                                        break;
                                    }
                                case 6: {
                                        message.typeBottom = reader.bool();
                                        break;
                                    }
                                case 7: {
                                        message.typeColor = reader.bool();
                                        break;
                                    }
                                case 8: {
                                        message.typeSpecial = reader.bool();
                                        break;
                                    }
                                case 9: {
                                        message.preventshade = reader.bool();
                                        break;
                                    }
                                case 10: {
                                        message.dmask = reader.bool();
                                        break;
                                    }
                                case 11: {
                                        message.opacity = reader.float();
                                        break;
                                    }
                                case 13: {
                                        message.speedplus = reader.float();
                                        break;
                                    }
                                case 14: {
                                        message.fontsize = reader.float();
                                        break;
                                    }
                                case 15: {
                                        message.fullscreensync = reader.bool();
                                        break;
                                    }
                                case 16: {
                                        message.speedsync = reader.bool();
                                        break;
                                    }
                                case 17: {
                                        message.fontfamily = reader.string();
                                        break;
                                    }
                                case 18: {
                                        message.bold = reader.bool();
                                        break;
                                    }
                                case 19: {
                                        message.fontborder = reader.int32();
                                        break;
                                    }
                                case 21: {
                                        message.seniorModeSwitch = reader.int32();
                                        break;
                                    }
                                case 24: {
                                        message.typeTopBottom = reader.bool();
                                        break;
                                    }
                                case 25: {
                                        message.dmarea = reader.int32();
                                        break;
                                    }
                                case 26: {
                                        message.dmdensity = reader.int32();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for DanmuWebPlayerConfig
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.DanmuWebPlayerConfig
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        DanmuWebPlayerConfig.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.DanmuWebPlayerConfig";
                        };

                        return DanmuWebPlayerConfig;
                    })();

                    v1.Expressions = (function() {

                        /**
                         * Properties of an Expressions.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IExpressions
                         * @property {Array.<bilibili.community.service.dm.v1.IExpression>|null} [data] Expressions data
                         */

                        /**
                         * Constructs a new Expressions.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents an Expressions.
                         * @implements IExpressions
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IExpressions=} [properties] Properties to set
                         */
                        function Expressions(properties) {
                            this.data = [];
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * Expressions data.
                         * @member {Array.<bilibili.community.service.dm.v1.IExpression>} data
                         * @memberof bilibili.community.service.dm.v1.Expressions
                         * @instance
                         */
                        Expressions.prototype.data = $util.emptyArray;

                        /**
                         * Encodes the specified Expressions message. Does not implicitly {@link bilibili.community.service.dm.v1.Expressions.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.Expressions
                         * @static
                         * @param {bilibili.community.service.dm.v1.IExpressions} message Expressions message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        Expressions.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.data != null && message.data.length)
                                for (let i = 0; i < message.data.length; ++i)
                                    $root.bilibili.community.service.dm.v1.Expression.encode(message.data[i], writer.uint32(/* id 1, wireType 2 =*/10).fork()).ldelim();
                            return writer;
                        };

                        /**
                         * Decodes an Expressions message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.Expressions
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.Expressions} Expressions
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        Expressions.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.Expressions();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        if (!(message.data && message.data.length))
                                            message.data = [];
                                        message.data.push($root.bilibili.community.service.dm.v1.Expression.decode(reader, reader.uint32()));
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for Expressions
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.Expressions
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        Expressions.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.Expressions";
                        };

                        return Expressions;
                    })();

                    v1.Expression = (function() {

                        /**
                         * Properties of an Expression.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IExpression
                         * @property {Array.<string>|null} [keyword] Expression keyword
                         * @property {string|null} [url] Expression url
                         * @property {Array.<bilibili.community.service.dm.v1.IPeriod>|null} [period] Expression period
                         */

                        /**
                         * Constructs a new Expression.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents an Expression.
                         * @implements IExpression
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IExpression=} [properties] Properties to set
                         */
                        function Expression(properties) {
                            this.keyword = [];
                            this.period = [];
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * Expression keyword.
                         * @member {Array.<string>} keyword
                         * @memberof bilibili.community.service.dm.v1.Expression
                         * @instance
                         */
                        Expression.prototype.keyword = $util.emptyArray;

                        /**
                         * Expression url.
                         * @member {string} url
                         * @memberof bilibili.community.service.dm.v1.Expression
                         * @instance
                         */
                        Expression.prototype.url = "";

                        /**
                         * Expression period.
                         * @member {Array.<bilibili.community.service.dm.v1.IPeriod>} period
                         * @memberof bilibili.community.service.dm.v1.Expression
                         * @instance
                         */
                        Expression.prototype.period = $util.emptyArray;

                        /**
                         * Encodes the specified Expression message. Does not implicitly {@link bilibili.community.service.dm.v1.Expression.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.Expression
                         * @static
                         * @param {bilibili.community.service.dm.v1.IExpression} message Expression message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        Expression.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.keyword != null && message.keyword.length)
                                for (let i = 0; i < message.keyword.length; ++i)
                                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.keyword[i]);
                            if (message.url != null && Object.hasOwnProperty.call(message, "url"))
                                writer.uint32(/* id 2, wireType 2 =*/18).string(message.url);
                            if (message.period != null && message.period.length)
                                for (let i = 0; i < message.period.length; ++i)
                                    $root.bilibili.community.service.dm.v1.Period.encode(message.period[i], writer.uint32(/* id 3, wireType 2 =*/26).fork()).ldelim();
                            return writer;
                        };

                        /**
                         * Decodes an Expression message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.Expression
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.Expression} Expression
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        Expression.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.Expression();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        if (!(message.keyword && message.keyword.length))
                                            message.keyword = [];
                                        message.keyword.push(reader.string());
                                        break;
                                    }
                                case 2: {
                                        message.url = reader.string();
                                        break;
                                    }
                                case 3: {
                                        if (!(message.period && message.period.length))
                                            message.period = [];
                                        message.period.push($root.bilibili.community.service.dm.v1.Period.decode(reader, reader.uint32()));
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for Expression
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.Expression
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        Expression.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.Expression";
                        };

                        return Expression;
                    })();

                    v1.Period = (function() {

                        /**
                         * Properties of a Period.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IPeriod
                         * @property {number|null} [start] Period start
                         * @property {number|null} [end] Period end
                         */

                        /**
                         * Constructs a new Period.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a Period.
                         * @implements IPeriod
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IPeriod=} [properties] Properties to set
                         */
                        function Period(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * Period start.
                         * @member {number} start
                         * @memberof bilibili.community.service.dm.v1.Period
                         * @instance
                         */
                        Period.prototype.start = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * Period end.
                         * @member {number} end
                         * @memberof bilibili.community.service.dm.v1.Period
                         * @instance
                         */
                        Period.prototype.end = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * Encodes the specified Period message. Does not implicitly {@link bilibili.community.service.dm.v1.Period.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.Period
                         * @static
                         * @param {bilibili.community.service.dm.v1.IPeriod} message Period message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        Period.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.start != null && Object.hasOwnProperty.call(message, "start"))
                                writer.uint32(/* id 1, wireType 0 =*/8).int64(message.start);
                            if (message.end != null && Object.hasOwnProperty.call(message, "end"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int64(message.end);
                            return writer;
                        };

                        /**
                         * Decodes a Period message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.Period
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.Period} Period
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        Period.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.Period();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.start = reader.int64();
                                        break;
                                    }
                                case 2: {
                                        message.end = reader.int64();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for Period
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.Period
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        Period.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.Period";
                        };

                        return Period;
                    })();

                    v1.AnyBody = (function() {

                        /**
                         * Properties of an AnyBody.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IAnyBody
                         * @property {google.protobuf.IAny|null} [body] AnyBody body
                         */

                        /**
                         * Constructs a new AnyBody.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents an AnyBody.
                         * @implements IAnyBody
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IAnyBody=} [properties] Properties to set
                         */
                        function AnyBody(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * AnyBody body.
                         * @member {google.protobuf.IAny|null|undefined} body
                         * @memberof bilibili.community.service.dm.v1.AnyBody
                         * @instance
                         */
                        AnyBody.prototype.body = null;

                        /**
                         * Encodes the specified AnyBody message. Does not implicitly {@link bilibili.community.service.dm.v1.AnyBody.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.AnyBody
                         * @static
                         * @param {bilibili.community.service.dm.v1.IAnyBody} message AnyBody message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        AnyBody.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.body != null && Object.hasOwnProperty.call(message, "body"))
                                $root.google.protobuf.Any.encode(message.body, writer.uint32(/* id 1, wireType 2 =*/10).fork()).ldelim();
                            return writer;
                        };

                        /**
                         * Decodes an AnyBody message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.AnyBody
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.AnyBody} AnyBody
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        AnyBody.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.AnyBody();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.body = $root.google.protobuf.Any.decode(reader, reader.uint32());
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for AnyBody
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.AnyBody
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        AnyBody.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.AnyBody";
                        };

                        return AnyBody;
                    })();

                    v1.DmColorful = (function() {

                        /**
                         * Properties of a DmColorful.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IDmColorful
                         * @property {bilibili.community.service.dm.v1.DmColorfulType|null} [type] DmColorful type
                         * @property {string|null} [src] DmColorful src
                         */

                        /**
                         * Constructs a new DmColorful.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a DmColorful.
                         * @implements IDmColorful
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IDmColorful=} [properties] Properties to set
                         */
                        function DmColorful(properties) {
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * DmColorful type.
                         * @member {bilibili.community.service.dm.v1.DmColorfulType} type
                         * @memberof bilibili.community.service.dm.v1.DmColorful
                         * @instance
                         */
                        DmColorful.prototype.type = 0;

                        /**
                         * DmColorful src.
                         * @member {string} src
                         * @memberof bilibili.community.service.dm.v1.DmColorful
                         * @instance
                         */
                        DmColorful.prototype.src = "";

                        /**
                         * Encodes the specified DmColorful message. Does not implicitly {@link bilibili.community.service.dm.v1.DmColorful.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.DmColorful
                         * @static
                         * @param {bilibili.community.service.dm.v1.IDmColorful} message DmColorful message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        DmColorful.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.type != null && Object.hasOwnProperty.call(message, "type"))
                                writer.uint32(/* id 1, wireType 0 =*/8).int32(message.type);
                            if (message.src != null && Object.hasOwnProperty.call(message, "src"))
                                writer.uint32(/* id 2, wireType 2 =*/18).string(message.src);
                            return writer;
                        };

                        /**
                         * Decodes a DmColorful message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.DmColorful
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.DmColorful} DmColorful
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        DmColorful.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.DmColorful();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.type = reader.int32();
                                        break;
                                    }
                                case 2: {
                                        message.src = reader.string();
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for DmColorful
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.DmColorful
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        DmColorful.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.DmColorful";
                        };

                        return DmColorful;
                    })();

                    /**
                     * DmColorfulType enum.
                     * @name bilibili.community.service.dm.v1.DmColorfulType
                     * @enum {number}
                     * @property {number} NoneType=0 NoneType value
                     * @property {number} VipGradualColor=60001 VipGradualColor value
                     */
                    v1.DmColorfulType = (function() {
                        const valuesById = {}, values = Object.create(valuesById);
                        values[valuesById[0] = "NoneType"] = 0;
                        values[valuesById[60001] = "VipGradualColor"] = 60001;
                        return values;
                    })();

                    v1.DmSubView = (function() {

                        /**
                         * Properties of a DmSubView.
                         * @memberof bilibili.community.service.dm.v1
                         * @interface IDmSubView
                         * @property {number|null} [type] DmSubView type
                         * @property {number|null} [oid] DmSubView oid
                         * @property {number|null} [pid] DmSubView pid
                         * @property {Array.<bilibili.community.service.dm.v1.IPostPanelV2>|null} [postPanel_2] DmSubView postPanel_2
                         */

                        /**
                         * Constructs a new DmSubView.
                         * @memberof bilibili.community.service.dm.v1
                         * @classdesc Represents a DmSubView.
                         * @implements IDmSubView
                         * @constructor
                         * @param {bilibili.community.service.dm.v1.IDmSubView=} [properties] Properties to set
                         */
                        function DmSubView(properties) {
                            this.postPanel_2 = [];
                            if (properties)
                                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                                    if (properties[keys[i]] != null)
                                        this[keys[i]] = properties[keys[i]];
                        }

                        /**
                         * DmSubView type.
                         * @member {number} type
                         * @memberof bilibili.community.service.dm.v1.DmSubView
                         * @instance
                         */
                        DmSubView.prototype.type = 0;

                        /**
                         * DmSubView oid.
                         * @member {number} oid
                         * @memberof bilibili.community.service.dm.v1.DmSubView
                         * @instance
                         */
                        DmSubView.prototype.oid = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * DmSubView pid.
                         * @member {number} pid
                         * @memberof bilibili.community.service.dm.v1.DmSubView
                         * @instance
                         */
                        DmSubView.prototype.pid = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

                        /**
                         * DmSubView postPanel_2.
                         * @member {Array.<bilibili.community.service.dm.v1.IPostPanelV2>} postPanel_2
                         * @memberof bilibili.community.service.dm.v1.DmSubView
                         * @instance
                         */
                        DmSubView.prototype.postPanel_2 = $util.emptyArray;

                        /**
                         * Encodes the specified DmSubView message. Does not implicitly {@link bilibili.community.service.dm.v1.DmSubView.verify|verify} messages.
                         * @function encode
                         * @memberof bilibili.community.service.dm.v1.DmSubView
                         * @static
                         * @param {bilibili.community.service.dm.v1.IDmSubView} message DmSubView message or plain object to encode
                         * @param {$protobuf.Writer} [writer] Writer to encode to
                         * @returns {$protobuf.Writer} Writer
                         */
                        DmSubView.encode = function encode(message, writer) {
                            if (!writer)
                                writer = $Writer.create();
                            if (message.type != null && Object.hasOwnProperty.call(message, "type"))
                                writer.uint32(/* id 1, wireType 0 =*/8).int32(message.type);
                            if (message.oid != null && Object.hasOwnProperty.call(message, "oid"))
                                writer.uint32(/* id 2, wireType 0 =*/16).int64(message.oid);
                            if (message.pid != null && Object.hasOwnProperty.call(message, "pid"))
                                writer.uint32(/* id 3, wireType 0 =*/24).int64(message.pid);
                            if (message.postPanel_2 != null && message.postPanel_2.length)
                                for (let i = 0; i < message.postPanel_2.length; ++i)
                                    $root.bilibili.community.service.dm.v1.PostPanelV2.encode(message.postPanel_2[i], writer.uint32(/* id 4, wireType 2 =*/34).fork()).ldelim();
                            return writer;
                        };

                        /**
                         * Decodes a DmSubView message from the specified reader or buffer.
                         * @function decode
                         * @memberof bilibili.community.service.dm.v1.DmSubView
                         * @static
                         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
                         * @param {number} [length] Message length if known beforehand
                         * @returns {bilibili.community.service.dm.v1.DmSubView} DmSubView
                         * @throws {Error} If the payload is not a reader or valid buffer
                         * @throws {$protobuf.util.ProtocolError} If required fields are missing
                         */
                        DmSubView.decode = function decode(reader, length) {
                            if (!(reader instanceof $Reader))
                                reader = $Reader.create(reader);
                            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.bilibili.community.service.dm.v1.DmSubView();
                            while (reader.pos < end) {
                                let tag = reader.uint32();
                                switch (tag >>> 3) {
                                case 1: {
                                        message.type = reader.int32();
                                        break;
                                    }
                                case 2: {
                                        message.oid = reader.int64();
                                        break;
                                    }
                                case 3: {
                                        message.pid = reader.int64();
                                        break;
                                    }
                                case 4: {
                                        if (!(message.postPanel_2 && message.postPanel_2.length))
                                            message.postPanel_2 = [];
                                        message.postPanel_2.push($root.bilibili.community.service.dm.v1.PostPanelV2.decode(reader, reader.uint32()));
                                        break;
                                    }
                                default:
                                    reader.skipType(tag & 7);
                                    break;
                                }
                            }
                            return message;
                        };

                        /**
                         * Gets the default type url for DmSubView
                         * @function getTypeUrl
                         * @memberof bilibili.community.service.dm.v1.DmSubView
                         * @static
                         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
                         * @returns {string} The default type url
                         */
                        DmSubView.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                            if (typeUrlPrefix === undefined) {
                                typeUrlPrefix = "type.googleapis.com";
                            }
                            return typeUrlPrefix + "/bilibili.community.service.dm.v1.DmSubView";
                        };

                        return DmSubView;
                    })();

                    return v1;
                })();

                return dm;
            })();

            return service;
        })();

        return community;
    })();

    return bilibili;
})();

$root.google = (() => {

    /**
     * Namespace google.
     * @exports google
     * @namespace
     */
    const google = {};

    google.protobuf = (function() {

        /**
         * Namespace protobuf.
         * @memberof google
         * @namespace
         */
        const protobuf = {};

        protobuf.Any = (function() {

            /**
             * Properties of an Any.
             * @memberof google.protobuf
             * @interface IAny
             * @property {string|null} [type_url] Any type_url
             * @property {Uint8Array|null} [value] Any value
             */

            /**
             * Constructs a new Any.
             * @memberof google.protobuf
             * @classdesc Represents an Any.
             * @implements IAny
             * @constructor
             * @param {google.protobuf.IAny=} [properties] Properties to set
             */
            function Any(properties) {
                if (properties)
                    for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null)
                            this[keys[i]] = properties[keys[i]];
            }

            /**
             * Any type_url.
             * @member {string} type_url
             * @memberof google.protobuf.Any
             * @instance
             */
            Any.prototype.type_url = "";

            /**
             * Any value.
             * @member {Uint8Array} value
             * @memberof google.protobuf.Any
             * @instance
             */
            Any.prototype.value = $util.newBuffer([]);

            /**
             * Encodes the specified Any message. Does not implicitly {@link google.protobuf.Any.verify|verify} messages.
             * @function encode
             * @memberof google.protobuf.Any
             * @static
             * @param {google.protobuf.IAny} message Any message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            Any.encode = function encode(message, writer) {
                if (!writer)
                    writer = $Writer.create();
                if (message.type_url != null && Object.hasOwnProperty.call(message, "type_url"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.type_url);
                if (message.value != null && Object.hasOwnProperty.call(message, "value"))
                    writer.uint32(/* id 2, wireType 2 =*/18).bytes(message.value);
                return writer;
            };

            /**
             * Decodes an Any message from the specified reader or buffer.
             * @function decode
             * @memberof google.protobuf.Any
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {google.protobuf.Any} Any
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            Any.decode = function decode(reader, length) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                let end = length === undefined ? reader.len : reader.pos + length, message = new $root.google.protobuf.Any();
                while (reader.pos < end) {
                    let tag = reader.uint32();
                    switch (tag >>> 3) {
                    case 1: {
                            message.type_url = reader.string();
                            break;
                        }
                    case 2: {
                            message.value = reader.bytes();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7);
                        break;
                    }
                }
                return message;
            };

            /**
             * Gets the default type url for Any
             * @function getTypeUrl
             * @memberof google.protobuf.Any
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            Any.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/google.protobuf.Any";
            };

            return Any;
        })();

        return protobuf;
    })();

    return google;
})();

var md5$1 = {exports: {}};

var crypt = {exports: {}};

(function() {
  var base64map
      = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',

  crypt$1 = {
    // Bit-wise rotation left
    rotl: function(n, b) {
      return (n << b) | (n >>> (32 - b));
    },

    // Bit-wise rotation right
    rotr: function(n, b) {
      return (n << (32 - b)) | (n >>> b);
    },

    // Swap big-endian to little-endian and vice versa
    endian: function(n) {
      // If number given, swap endian
      if (n.constructor == Number) {
        return crypt$1.rotl(n, 8) & 0x00FF00FF | crypt$1.rotl(n, 24) & 0xFF00FF00;
      }

      // Else, assume array and swap all items
      for (var i = 0; i < n.length; i++)
        n[i] = crypt$1.endian(n[i]);
      return n;
    },

    // Generate an array of any length of random bytes
    randomBytes: function(n) {
      for (var bytes = []; n > 0; n--)
        bytes.push(Math.floor(Math.random() * 256));
      return bytes;
    },

    // Convert a byte array to big-endian 32-bit words
    bytesToWords: function(bytes) {
      for (var words = [], i = 0, b = 0; i < bytes.length; i++, b += 8)
        words[b >>> 5] |= bytes[i] << (24 - b % 32);
      return words;
    },

    // Convert big-endian 32-bit words to a byte array
    wordsToBytes: function(words) {
      for (var bytes = [], b = 0; b < words.length * 32; b += 8)
        bytes.push((words[b >>> 5] >>> (24 - b % 32)) & 0xFF);
      return bytes;
    },

    // Convert a byte array to a hex string
    bytesToHex: function(bytes) {
      for (var hex = [], i = 0; i < bytes.length; i++) {
        hex.push((bytes[i] >>> 4).toString(16));
        hex.push((bytes[i] & 0xF).toString(16));
      }
      return hex.join('');
    },

    // Convert a hex string to a byte array
    hexToBytes: function(hex) {
      for (var bytes = [], c = 0; c < hex.length; c += 2)
        bytes.push(parseInt(hex.substr(c, 2), 16));
      return bytes;
    },

    // Convert a byte array to a base-64 string
    bytesToBase64: function(bytes) {
      for (var base64 = [], i = 0; i < bytes.length; i += 3) {
        var triplet = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        for (var j = 0; j < 4; j++)
          if (i * 8 + j * 6 <= bytes.length * 8)
            base64.push(base64map.charAt((triplet >>> 6 * (3 - j)) & 0x3F));
          else
            base64.push('=');
      }
      return base64.join('');
    },

    // Convert a base-64 string to a byte array
    base64ToBytes: function(base64) {
      // Remove non-base-64 characters
      base64 = base64.replace(/[^A-Z0-9+\/]/ig, '');

      for (var bytes = [], i = 0, imod4 = 0; i < base64.length;
          imod4 = ++i % 4) {
        if (imod4 == 0) continue;
        bytes.push(((base64map.indexOf(base64.charAt(i - 1))
            & (Math.pow(2, -2 * imod4 + 8) - 1)) << (imod4 * 2))
            | (base64map.indexOf(base64.charAt(i)) >>> (6 - imod4 * 2)));
      }
      return bytes;
    }
  };

  crypt.exports = crypt$1;
})();

var cryptExports = crypt.exports;

var charenc = {
  // UTF-8 encoding
  utf8: {
    // Convert a string to a byte array
    stringToBytes: function(str) {
      return charenc.bin.stringToBytes(unescape(encodeURIComponent(str)));
    },

    // Convert a byte array to a string
    bytesToString: function(bytes) {
      return decodeURIComponent(escape(charenc.bin.bytesToString(bytes)));
    }
  },

  // Binary encoding
  bin: {
    // Convert a string to a byte array
    stringToBytes: function(str) {
      for (var bytes = [], i = 0; i < str.length; i++)
        bytes.push(str.charCodeAt(i) & 0xFF);
      return bytes;
    },

    // Convert a byte array to a string
    bytesToString: function(bytes) {
      for (var str = [], i = 0; i < bytes.length; i++)
        str.push(String.fromCharCode(bytes[i]));
      return str.join('');
    }
  }
};

var charenc_1 = charenc;

/*!
 * Determine if an object is a Buffer
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */

// The _isBuffer check is for Safari 5-7 support, because it's missing
// Object.prototype.constructor. Remove this eventually
var isBuffer_1 = function (obj) {
  return obj != null && (isBuffer(obj) || isSlowBuffer(obj) || !!obj._isBuffer)
};

function isBuffer (obj) {
  return !!obj.constructor && typeof obj.constructor.isBuffer === 'function' && obj.constructor.isBuffer(obj)
}

// For Node v0.10 support. Remove this eventually.
function isSlowBuffer (obj) {
  return typeof obj.readFloatLE === 'function' && typeof obj.slice === 'function' && isBuffer(obj.slice(0, 0))
}

(function(){
  var crypt = cryptExports,
      utf8 = charenc_1.utf8,
      isBuffer = isBuffer_1,
      bin = charenc_1.bin,

  // The core
  md5 = function (message, options) {
    // Convert to byte array
    if (message.constructor == String)
      if (options && options.encoding === 'binary')
        message = bin.stringToBytes(message);
      else
        message = utf8.stringToBytes(message);
    else if (isBuffer(message))
      message = Array.prototype.slice.call(message, 0);
    else if (!Array.isArray(message) && message.constructor !== Uint8Array)
      message = message.toString();
    // else, assume byte array already

    var m = crypt.bytesToWords(message),
        l = message.length * 8,
        a =  1732584193,
        b = -271733879,
        c = -1732584194,
        d =  271733878;

    // Swap endian
    for (var i = 0; i < m.length; i++) {
      m[i] = ((m[i] <<  8) | (m[i] >>> 24)) & 0x00FF00FF |
             ((m[i] << 24) | (m[i] >>>  8)) & 0xFF00FF00;
    }

    // Padding
    m[l >>> 5] |= 0x80 << (l % 32);
    m[(((l + 64) >>> 9) << 4) + 14] = l;

    // Method shortcuts
    var FF = md5._ff,
        GG = md5._gg,
        HH = md5._hh,
        II = md5._ii;

    for (var i = 0; i < m.length; i += 16) {

      var aa = a,
          bb = b,
          cc = c,
          dd = d;

      a = FF(a, b, c, d, m[i+ 0],  7, -680876936);
      d = FF(d, a, b, c, m[i+ 1], 12, -389564586);
      c = FF(c, d, a, b, m[i+ 2], 17,  606105819);
      b = FF(b, c, d, a, m[i+ 3], 22, -1044525330);
      a = FF(a, b, c, d, m[i+ 4],  7, -176418897);
      d = FF(d, a, b, c, m[i+ 5], 12,  1200080426);
      c = FF(c, d, a, b, m[i+ 6], 17, -1473231341);
      b = FF(b, c, d, a, m[i+ 7], 22, -45705983);
      a = FF(a, b, c, d, m[i+ 8],  7,  1770035416);
      d = FF(d, a, b, c, m[i+ 9], 12, -1958414417);
      c = FF(c, d, a, b, m[i+10], 17, -42063);
      b = FF(b, c, d, a, m[i+11], 22, -1990404162);
      a = FF(a, b, c, d, m[i+12],  7,  1804603682);
      d = FF(d, a, b, c, m[i+13], 12, -40341101);
      c = FF(c, d, a, b, m[i+14], 17, -1502002290);
      b = FF(b, c, d, a, m[i+15], 22,  1236535329);

      a = GG(a, b, c, d, m[i+ 1],  5, -165796510);
      d = GG(d, a, b, c, m[i+ 6],  9, -1069501632);
      c = GG(c, d, a, b, m[i+11], 14,  643717713);
      b = GG(b, c, d, a, m[i+ 0], 20, -373897302);
      a = GG(a, b, c, d, m[i+ 5],  5, -701558691);
      d = GG(d, a, b, c, m[i+10],  9,  38016083);
      c = GG(c, d, a, b, m[i+15], 14, -660478335);
      b = GG(b, c, d, a, m[i+ 4], 20, -405537848);
      a = GG(a, b, c, d, m[i+ 9],  5,  568446438);
      d = GG(d, a, b, c, m[i+14],  9, -1019803690);
      c = GG(c, d, a, b, m[i+ 3], 14, -187363961);
      b = GG(b, c, d, a, m[i+ 8], 20,  1163531501);
      a = GG(a, b, c, d, m[i+13],  5, -1444681467);
      d = GG(d, a, b, c, m[i+ 2],  9, -51403784);
      c = GG(c, d, a, b, m[i+ 7], 14,  1735328473);
      b = GG(b, c, d, a, m[i+12], 20, -1926607734);

      a = HH(a, b, c, d, m[i+ 5],  4, -378558);
      d = HH(d, a, b, c, m[i+ 8], 11, -2022574463);
      c = HH(c, d, a, b, m[i+11], 16,  1839030562);
      b = HH(b, c, d, a, m[i+14], 23, -35309556);
      a = HH(a, b, c, d, m[i+ 1],  4, -1530992060);
      d = HH(d, a, b, c, m[i+ 4], 11,  1272893353);
      c = HH(c, d, a, b, m[i+ 7], 16, -155497632);
      b = HH(b, c, d, a, m[i+10], 23, -1094730640);
      a = HH(a, b, c, d, m[i+13],  4,  681279174);
      d = HH(d, a, b, c, m[i+ 0], 11, -358537222);
      c = HH(c, d, a, b, m[i+ 3], 16, -722521979);
      b = HH(b, c, d, a, m[i+ 6], 23,  76029189);
      a = HH(a, b, c, d, m[i+ 9],  4, -640364487);
      d = HH(d, a, b, c, m[i+12], 11, -421815835);
      c = HH(c, d, a, b, m[i+15], 16,  530742520);
      b = HH(b, c, d, a, m[i+ 2], 23, -995338651);

      a = II(a, b, c, d, m[i+ 0],  6, -198630844);
      d = II(d, a, b, c, m[i+ 7], 10,  1126891415);
      c = II(c, d, a, b, m[i+14], 15, -1416354905);
      b = II(b, c, d, a, m[i+ 5], 21, -57434055);
      a = II(a, b, c, d, m[i+12],  6,  1700485571);
      d = II(d, a, b, c, m[i+ 3], 10, -1894986606);
      c = II(c, d, a, b, m[i+10], 15, -1051523);
      b = II(b, c, d, a, m[i+ 1], 21, -2054922799);
      a = II(a, b, c, d, m[i+ 8],  6,  1873313359);
      d = II(d, a, b, c, m[i+15], 10, -30611744);
      c = II(c, d, a, b, m[i+ 6], 15, -1560198380);
      b = II(b, c, d, a, m[i+13], 21,  1309151649);
      a = II(a, b, c, d, m[i+ 4],  6, -145523070);
      d = II(d, a, b, c, m[i+11], 10, -1120210379);
      c = II(c, d, a, b, m[i+ 2], 15,  718787259);
      b = II(b, c, d, a, m[i+ 9], 21, -343485551);

      a = (a + aa) >>> 0;
      b = (b + bb) >>> 0;
      c = (c + cc) >>> 0;
      d = (d + dd) >>> 0;
    }

    return crypt.endian([a, b, c, d]);
  };

  // Auxiliary functions
  md5._ff  = function (a, b, c, d, x, s, t) {
    var n = a + (b & c | ~b & d) + (x >>> 0) + t;
    return ((n << s) | (n >>> (32 - s))) + b;
  };
  md5._gg  = function (a, b, c, d, x, s, t) {
    var n = a + (b & d | c & ~d) + (x >>> 0) + t;
    return ((n << s) | (n >>> (32 - s))) + b;
  };
  md5._hh  = function (a, b, c, d, x, s, t) {
    var n = a + (b ^ c ^ d) + (x >>> 0) + t;
    return ((n << s) | (n >>> (32 - s))) + b;
  };
  md5._ii  = function (a, b, c, d, x, s, t) {
    var n = a + (c ^ (b | ~d)) + (x >>> 0) + t;
    return ((n << s) | (n >>> (32 - s))) + b;
  };

  // Package private blocksize
  md5._blocksize = 16;
  md5._digestsize = 16;

  md5$1.exports = function (message, options) {
    if (message === undefined || message === null)
      throw new Error('Illegal argument ' + message);

    var digestbytes = crypt.wordsToBytes(md5(message, options));
    return options && options.asBytes ? digestbytes :
        options && options.asString ? bin.bytesToString(digestbytes) :
        crypt.bytesToHex(digestbytes);
  };

})();

var md5Exports = md5$1.exports;
var md5 = /*@__PURE__*/getDefaultExportFromCjs(md5Exports);

let proto_seg = $root.bilibili.community.service.dm.v1.DmSegMobileReply;
let proto_view = $root.bilibili.community.service.dm.v1.DmWebViewReply;
function protobuf_to_obj(segidx, chunk) {
    return {
        objs: chunk.elems.map((item) => ({
            'time_ms': item.stime,
            'mode': item.mode,
            'fontsize': item.size,
            'color': item.color,
            'sender_hash': item.uhash,
            'content': item.text,
            'sendtime': item.date,
            'weight': item.weight,
            'id': item.dmid,
            'pool': item.pool,
            'extra': {
                'proto_attr': item.attr,
                'proto_action': item.action,
                'proto_animation': item.animation,
                'proto_colorful': item.colorful,
                'proto_oid': item.oid,
                'proto_dmfrom': item.dmFrom,
            },
        })),
        extra: {
            'proto_segidx': segidx,
            'proto_colorfulsrc': chunk.colorfulSrc,
        },
    };
}
function obj_to_protobuf(egress, chunk) {
    let objs = chunk.objs;
    if (egress.ps || egress.pe) {
        let ps = egress.ps || 0;
        let pe = egress.pe || 999999999999;
        objs = objs.filter((item, idx) => ps <= item.time_ms && item.time_ms < pe);
    }
    let res = objs.map((item) => ({
        "stime": item.time_ms,
        "mode": item.mode,
        "size": item.fontsize,
        "color": item.color,
        "uhash": item.sender_hash,
        "text": item.content,
        "date": item.sendtime,
        "weight": item.weight,
        "dmid": item.id,
        "attr": item.extra.proto_attr,
        "action": item.extra.proto_action || null,
        "animation": item.extra.proto_animation || null,
        "colorful": item.extra.proto_colorful,
        "oid": item.extra.proto_oid,
        "dmFrom": item.extra.proto_dmfrom || null,
    }));
    return proto_seg.encode({ elems: res, colorfulSrc: chunk.extra.proto_colorfulsrc || [] }).finish();
}
function protoapi_sign_req(e, protoapi_img_url, protoapi_sub_url) {
    let static_img_url = "https://i0.hdslb.com/bfs/wbi/5a6f002d0bb14fc9848fc64157648ad4.png";
    let static_sub_url = "https://i0.hdslb.com/bfs/wbi/0503a77b29d7409d9548fb44fe9daa1a.png";
    e.web_location = 1315873;
    let t = protoapi_img_url || static_img_url;
    let r = protoapi_sub_url || static_sub_url;
    let n = function (e) {
        let t = [];
        // noinspection CommaExpressionJS
        return [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52].forEach((function (r) {
            e.charAt(r) && t.push(e.charAt(r));
        })),
            t.join("").slice(0, 32);
    }(t.substring(t.lastIndexOf("/") + 1, t.length).split(".")[0] + r.substring(r.lastIndexOf("/") + 1, r.length).split(".")[0]);
    let i = Math.round(Date.now() / 1e3);
    let o = Object.assign({}, e, {
        wts: i
    });
    let a = Object.keys(o).sort();
    let s = [];
    for (let c = 0; c < a.length; c++) {
        let p = a[c], h = o[p];
        null != h && s.push("".concat(encodeURIComponent(p), "=").concat(encodeURIComponent(h)));
    }
    let y = s.join("&");
    let m = md5(y + n);
    return Object.assign(e, {
        w_rid: m,
        wts: i.toString()
    });
}
async function protoapi_view_api(ingress) {
    console.log('pakku protobuf api: request view api', ingress);
    let res = await fetch(`https://api.bilibili.com/x/v2/dm/web/view?type=1&oid=${encodeURIComponent(ingress.cid)}&pid=${encodeURIComponent(ingress.pid)}`, { credentials: 'include' });
    return await res.arrayBuffer();
}
async function protoapi_get_view(view_response) {
    let buffer = await view_response;
    let arr = new Uint8Array(buffer);
    return proto_view.decode(arr);
}
function protoapi_encode_view(view) {
    return proto_view.encode(view).finish();
}
async function protoapi_get_segcount(view_response) {
    let d = await protoapi_get_view(view_response);
    console.log('pakku protobuf api: got view', d);
    if (d.dmSge && d.dmSge.total && d.dmSge.total < 100)
        return d.dmSge.total;
    else
        return null;
}
async function protoapi_get_url(url) {
    let res = await fetch(url, { credentials: 'include' });
    let buffer = await res.arrayBuffer();
    let arr = new Uint8Array(buffer);
    return proto_seg.decode(arr);
}
async function protoapi_get_seg(ingress, segidx) {
    let param = protoapi_sign_req({
        'type': '1',
        'oid': ingress.cid,
        'pid': ingress.pid,
        'segment_index': segidx,
    }, ingress.static_img_url, ingress.static_sub_url);
    let param_list = [];
    for (let key in param) {
        param_list.push(key + '=' + encodeURIComponent(param[key]));
    }
    let param_str = param_list.join('&');
    return await protoapi_get_url('https://api.bilibili.com/x/v2/dm/wbi/web/seg.so?' + param_str);
}
function protoapi_get_prefetch(ingress, view_url) {
    let duration = parseInt(new URLSearchParams(view_url.split('?')[1] || '').get('duration') || '0');
    let guessed_chunks = duration ? Math.ceil((1 + duration) / 360) : null;
    return {
        view: fetch(view_url, { credentials: 'include' }).then(r => r.arrayBuffer()),
        chunk_1: protoapi_get_seg(ingress, 1),
        chunk_2: (guessed_chunks && guessed_chunks > 1) ? protoapi_get_seg(ingress, 2) : null,
        guessed_chunks: guessed_chunks,
    };
}
async function ingress_proto_history(ingress, chunk_callback) {
    let d = await protoapi_get_url(ingress.url);
    await chunk_callback(1, protobuf_to_obj(1, d));
}
async function ingress_proto_seg(ingress, chunk_callback, prefetch) {
    async function return_from_resp(idx, resp) {
        await chunk_callback(idx, protobuf_to_obj(idx, await resp));
    }
    // noinspection ES6MissingAwait
    let chunk_1_req = (prefetch && prefetch.chunk_1) ? prefetch.chunk_1 : protoapi_get_seg(ingress, 1);
    // noinspection ES6MissingAwait
    let chunk_2_req = (prefetch && prefetch.chunk_2) ? prefetch.chunk_2 : protoapi_get_seg(ingress, 2);
    let pages = await protoapi_get_segcount(prefetch ? prefetch.view : protoapi_view_api(ingress));
    if (pages) {
        if (pages <= 1) {
            await return_from_resp(1, chunk_1_req);
            return;
        }
        // noinspection ES6MissingAwait
        let jobs = [return_from_resp(1, chunk_1_req), return_from_resp(2, chunk_2_req)];
        for (let i = 3; i <= pages; i++)
            jobs.push(return_from_resp(i, protoapi_get_seg(ingress, i)));
        await Promise.all(jobs);
    }
    else { // guess page numbers
        console.log('pakku protobuf api: guessing page numbers');
        // noinspection ES6MissingAwait
        let req = [chunk_1_req, chunk_2_req, protoapi_get_seg(ingress, 3)];
        async function work(idx) {
            let d = await req.shift();
            if (d.elems.length) {
                await chunk_callback(idx, protobuf_to_obj(idx, d));
                req.push(protoapi_get_seg(ingress, idx + 3));
                await work(idx + 1);
            }
            else { // finished?
                let dd = await req.shift();
                if (dd.elems.length) { // no
                    await chunk_callback(idx, protobuf_to_obj(idx, d));
                    await chunk_callback(idx + 1, protobuf_to_obj(idx + 1, dd));
                    req.push(protoapi_get_seg(ingress, idx + 3));
                    req.push(protoapi_get_seg(ingress, idx + 4));
                    await work(idx + 2);
                }
                else { // probably yes
                    console.log('pakku protobuf api: ASSUMING total', idx - 1, 'pages');
                    if (idx === 1) { // the logic doesn't for 0 pages, so we emit an empty chunk
                        await chunk_callback(1, protobuf_to_obj(1, d));
                    }
                    return;
                }
            }
        }
        await work(1);
    }
}
function egress_proto(egress, num_chunks, chunks) {
    function missing_data() {
        if (egress.wait_finished)
            return MissingData;
        else
            return obj_to_protobuf(egress, { objs: [], extra: {} });
    }
    if (egress.segidx === null) { // want all chunks
        if (!num_chunks || num_chunks !== chunks.size)
            return missing_data(); // not finished
        let chunk = {
            objs: [...chunks.values()].flatMap(c => c.objs),
            extra: {},
        };
        return obj_to_protobuf(egress, chunk);
    }
    else { // want specific chunk
        let new_egress = { ...egress };
        if (egress.segidx > 1) { // xxx: all danmus belong to the first chunk in xml ingress
            new_egress.ps = 360000 * (egress.segidx - 1);
            new_egress.pe = 360000 * egress.segidx;
            new_egress.segidx = 1;
        }
        let chunk = chunks.get(new_egress.segidx);
        if (!chunk)
            return missing_data();
        return obj_to_protobuf(new_egress, chunk);
    }
}

const REMOVE_COMMENTS_RE = /^\s*\/\/.*$/gm;
const REMOVE_LAST_COMMA_RE = /,\s*]\s*$/g;
function get_objects(content) {
    content = content.replace(REMOVE_COMMENTS_RE, '').replace(REMOVE_LAST_COMMA_RE, ']');
    let obj = JSON.parse(content);
    if (!Array.isArray(obj))
        throw new Error('pakku ingress debug: content is not an array');
    for (let o of obj) {
        if (typeof o !== 'object')
            throw new Error('pakku ingress debug: array item is not object');
        if (!o.extra)
            throw new Error('pakku ingress debug: array item is not danmu object');
    }
    return obj;
}
async function ingress_debug_content(ingress, chunk_callback) {
    let chunk = { objs: get_objects(ingress.content), extra: {} };
    await chunk_callback(1, chunk);
}
function egress_debug(egress, num_chunks, chunks) {
    if (egress.wait_finished && (!num_chunks || num_chunks !== chunks.size))
        return MissingData; // not finished
    let ret = [];
    ret.push(`// num_chunks: ${chunks.size} / ${num_chunks}`);
    ret.push('[');
    let sorted_chunk_keys = Array.from(chunks.keys()).sort((a, b) => a - b);
    for (let chunk_idx of sorted_chunk_keys) {
        let chunk = chunks.get(chunk_idx);
        ret.push(`// chunk ${chunk_idx}: ${JSON.stringify(chunk.extra)}`);
        for (let obj of chunk.objs) {
            let o = obj;
            if (!egress.show_peers && obj.pakku) {
                o = { ...obj, pakku: { ...obj.pakku, peers: null } };
            }
            ret.push(`  ${JSON.stringify(o)} ,`);
        }
    }
    ret.push(']');
    return ret.join('\n');
}

function ts_assert_never(x) {
    throw new Error('Unexpected object: ' + x);
}
async function perform_ingress(ingress, chunk_callback, prefetch = null) {
    if (ingress.type === 'xml')
        return await ingress_xml(ingress, chunk_callback);
    else if (ingress.type === 'xml_content')
        return await ingress_xml_content(ingress, chunk_callback);
    else if (ingress.type === 'proto_seg')
        return await ingress_proto_seg(ingress, chunk_callback, prefetch);
    else if (ingress.type === 'proto_history')
        return await ingress_proto_history(ingress, chunk_callback);
    else if (ingress.type === 'debug_content')
        return await ingress_debug_content(ingress, chunk_callback);
    else
        return ts_assert_never(ingress);
}
function perform_egress(egress, num_chunks, chunks) {
    if (egress.type === 'xml')
        return egress_xml(egress, num_chunks, chunks);
    else if (egress.type === 'proto_seg')
        return egress_proto(egress, num_chunks, chunks);
    else if (egress.type === 'debug')
        return egress_debug(egress, num_chunks, chunks);
    else
        return ts_assert_never(egress);
}

class Queue {
    storage;
    index_l;
    index_r; // [l, r)
    constructor(init = []) {
        this.storage = { ...init };
        this.index_l = 0;
        this.index_r = init.length;
    }
    push(item) {
        this.storage[this.index_r++] = item;
    }
    pop() {
        delete this.storage[this.index_l++];
    }
    peek() {
        if (this.index_l === this.index_r)
            return null;
        return this.storage[this.index_l];
    }
    size() {
        return this.index_r - this.index_l;
    }
    [Symbol.iterator]() {
        let self = this;
        let index = self.index_l;
        return {
            next() {
                if (index >= self.index_r)
                    return { done: true, value: undefined };
                return { done: false, value: self.storage[index++] };
            }
        };
    }
}

const MATH_LOG5 = Math.log(5);
function calc_enlarge_rate(count) {
    return count <= 5 ? 1 : (Math.log(count) / MATH_LOG5);
}
const DISPVAL_TIME_THRESHOLD = 4500;
const DISPVAL_POWER = .35, SHRINK_MAX_RATE = 1.732;
const WEIGHT_DROPPED = -114514;
const _cvs = document.createElement('canvas');
const _ctx = _cvs.getContext('2d');
_ctx.font = `20px 黑体`;
function shuffle(array) {
    for (let i = array.length - 1; i >= 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        let temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
}
function get_width_if_exceeds(text, size, threshold) {
    if (text.length * size < threshold) // speedup
        return 0;
    return _ctx.measureText(text).width / 20 * size;
}
function trim_dispstr(text) {
    return text.replace(/([\r\n\t])/g, '').trim();
}
// \u2080 is subscript_number_0
const SUBSCRIPT_CHARS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(x => String.fromCharCode(0x2080 + x));
function to_subscript(x) {
    let ret = SUBSCRIPT_CHARS[x % 10];
    while (x >= 10) {
        x = (x / 10) | 0;
        ret = SUBSCRIPT_CHARS[x % 10] + ret;
    }
    return ret;
}
function make_mark_meta(config) {
    const MARK_THRESHOLD = config.MARK_THRESHOLD;
    if (config.DANMU_MARK === 'off')
        return (text, cnt) => text;
    else { // suffix or prefix
        let make_cnt;
        if (config.DANMU_SUBSCRIPT)
            make_cnt = (cnt) => `₍${to_subscript(cnt)}₎`;
        else
            make_cnt = (cnt) => `[x${cnt}]`;
        return config.DANMU_MARK === 'suffix' ?
            (text, cnt) => (cnt > MARK_THRESHOLD ? (text + make_cnt(cnt)) : text) : (text, cnt) => (cnt > MARK_THRESHOLD ? (make_cnt(cnt) + text) : text);
    }
}
function count_small_chars(s) {
    const SMALL_CHARS = new Set('₍₀₁₂₃₄₅₆₇₈₉₎↓↑');
    let ret = 0;
    for (let c of s)
        if (SMALL_CHARS.has(c))
            ret++;
    return ret;
}
function dispval(d) {
    let text_length;
    if (d.pakku?.disp_str) {
        // a representative value, check for small chars
        let dr = d;
        let str = dr.pakku.disp_str;
        text_length = str.length - (dr.pakku.peers.length > 1 ? (count_small_chars(str) * .7) : 0);
        //text_length = str.length;
    }
    else {
        // a peer value
        text_length = d.content.length;
    }
    return Math.sqrt(text_length) * Math.pow(Math.max(Math.min(d.fontsize / 25, 2.5), .7), 1.5);
}
let _last_config = null;
let make_mark;
function build_text(c, rep_dm) {
    let cnt = c.peers.length;
    let dumped = null;
    if (rep_dm.mode === 7 && rep_dm.content[0] === '[')
        try {
            dumped = JSON.parse(rep_dm.content);
        }
        catch (e) { }
    if (dumped) {
        dumped[4] = make_mark(dumped[4], cnt);
        rep_dm.pakku.disp_str = trim_dispstr(dumped[4]);
        rep_dm.content = JSON.stringify(dumped);
    }
    else {
        rep_dm.content = make_mark(rep_dm.content, cnt);
        rep_dm.pakku.disp_str = trim_dispstr(rep_dm.content);
    }
}
function judge_drop(dispval, threshold, peers, weight_distribution) {
    if (threshold <= 0 || dispval <= threshold)
        return false;
    let max_weight = Math.max(...peers.map(p => p.weight));
    let drop_rate = ((dispval - threshold) / threshold
        - (weight_distribution[max_weight - 1] || 0)
        - (Math.sqrt(peers.length) - 1) / 3);
    //console.log('!!!judge', dispval, max_weight, peers.length, drop_rate);
    return (drop_rate >= 1 || (drop_rate > 0 && Math.random() < drop_rate));
}
function post_combine(input_clusters, prev_input_clusters, input_chunk, config, stats) {
    if (input_chunk.objs.length === 0) // empty chunk
        return { objs: [], extra: input_chunk.extra };
    const THRESHOLD_MS = config.THRESHOLD * 1000;
    const FIRST_TIME_MS = input_chunk.objs[0].time_ms;
    if (config !== _last_config) {
        _last_config = config;
        make_mark = make_mark_meta(config);
    }
    let out_danmus = [];
    // calc danmus included in prev cluster
    let ids_included_in_prev = new Set();
    let max_included_time = -1;
    for (let i = prev_input_clusters.length - 1; i >= 0; i--) {
        let c = prev_input_clusters[i];
        if (c.peers[0].time_ms < FIRST_TIME_MS - THRESHOLD_MS)
            break;
        for (let p of c.peers) {
            ids_included_in_prev.add(p.id);
            max_included_time = Math.max(max_included_time, p.time_ms);
        }
    }
    // gen out_danmus
    for (let c of input_clusters) {
        // dedup from prev cluster
        if (c.peers[0].time_ms < max_included_time) {
            let old_len = c.peers.length;
            c.peers = c.peers.filter(p => !ids_included_in_prev.has(p.id));
            if (c.peers.length === 0)
                continue;
            if (c.peers.length !== old_len)
                c.desc.push(`已去除包含在上个分片中的 ${old_len - c.peers.length} 条弹幕`);
        }
        // select a representative obj and make a copy
        let _rep_dm = c.peers[Math.min(Math.floor(c.peers.length * config.REPRESENTATIVE_PERCENT / 100), c.peers.length - 1)];
        let rep_dm = {
            ..._rep_dm,
            content: c.chosen_str,
            extra: {
                ..._rep_dm.extra,
            },
            pakku: {
                peers: c.peers,
                desc: c.desc,
                disp_str: '',
            },
        };
        // text, mode elevation, fontsize enlarge, weight, proto_animation
        let max_dm_size = rep_dm.fontsize, max_weight = rep_dm.weight, max_mode = rep_dm.mode;
        for (let p of c.peers) {
            max_weight = Math.max(max_weight, p.weight);
            if (p.fontsize < 30)
                max_dm_size = Math.max(max_dm_size, p.fontsize);
            if (p.mode === 4) // bottom danmu get top priority
                max_mode = 4;
            else if (p.mode === 5 && max_mode !== 4) // top danmu get top priority
                max_mode = 5;
        }
        build_text(c, rep_dm);
        if (config.MODE_ELEVATION)
            rep_dm.mode = max_mode;
        rep_dm.fontsize = max_dm_size;
        rep_dm.weight = max_weight;
        if (config.ENLARGE) {
            let enlarge_rate = calc_enlarge_rate(c.peers.length);
            rep_dm.fontsize = Math.ceil(rep_dm.fontsize * enlarge_rate);
            if (enlarge_rate > 1.001) {
                c.desc.push(`已放大 ${enlarge_rate.toFixed(2)} 倍：合并数量为 ${c.peers.length}`);
                stats.modified_enlarge++;
            }
        }
        if (config.DANMU_MARK !== 'off' && c.peers.length > config.MARK_THRESHOLD) {
            // remove special effect for combined danmus
            rep_dm.extra.proto_animation = '';
        }
        // add to out_danmus
        out_danmus.push(rep_dm);
    }
    // final adjustments
    let need_dispval = config.SHRINK_THRESHOLD > 0 || config.DROP_THRESHOLD > 0 || config.POPUP_BADGE === 'dispval';
    const dispval_base = Math.pow(config.SHRINK_THRESHOLD, DISPVAL_POWER);
    let dispval_subtract = null;
    let onscreen_dispval = 0;
    let weight_distribution = Array.from({ length: 12 }).map(_ => 0);
    if (need_dispval) {
        out_danmus.sort((a, b) => a.time_ms - b.time_ms);
        // calc weight distribution
        for (let dm of out_danmus) {
            dm.weight = Math.max(1, Math.min(11, dm.weight)); // ensure weights are 1~11
            weight_distribution[dm.weight] += 1;
        }
        for (let i = 1; i <= 11; i++) {
            weight_distribution[i] /= out_danmus.length;
            weight_distribution[i] += weight_distribution[i - 1];
            weight_distribution[i - 1] = Math.pow((weight_distribution[i - 1] + weight_distribution[i]) / 2, 3);
        }
        //console.log('!!! weight', weight_distribution);
        // pre-populate dispval from the previous chunk
        let dispval_preload = [];
        let prev_dms = [];
        for (let i = prev_input_clusters.length - 1; i >= 0; i--) {
            let c = prev_input_clusters[i];
            if (c.peers[0].time_ms < FIRST_TIME_MS - DISPVAL_TIME_THRESHOLD)
                break;
            prev_dms.push(c);
        }
        shuffle(prev_dms); // make these pre-populated items disappear randomly in the current chunk, hence less biased
        for (let c of prev_dms) {
            // check drop
            if (judge_drop(onscreen_dispval, config.DROP_THRESHOLD, c.peers, weight_distribution)) {
                continue;
            }
            let rep_dm = c.peers[0];
            let dv = dispval(rep_dm);
            onscreen_dispval += dv;
            dispval_preload.push([rep_dm.time_ms + DISPVAL_TIME_THRESHOLD, dv]);
        }
        dispval_preload.sort((a, b) => a[0] - b[0]);
        dispval_subtract = new Queue(dispval_preload);
    }
    for (let dm of out_danmus) {
        if (need_dispval) {
            // update dispval
            let dv = dispval(dm);
            while (true) {
                let to_subtract = dispval_subtract.peek();
                if (to_subtract && dm.time_ms > to_subtract[0]) {
                    onscreen_dispval -= to_subtract[1];
                    dispval_subtract.pop();
                }
                else {
                    break;
                }
            }
            // check drop
            if (judge_drop(onscreen_dispval, config.DROP_THRESHOLD, dm.pakku.peers, weight_distribution)) {
                stats.deleted_dispval++;
                dm.weight = WEIGHT_DROPPED;
                continue;
            }
            onscreen_dispval += dv;
            dispval_subtract.push([dm.time_ms + DISPVAL_TIME_THRESHOLD, dv]);
            // check shrink
            if (config.SHRINK_THRESHOLD > 0 && onscreen_dispval > config.SHRINK_THRESHOLD) {
                let shrink_rate = Math.min(Math.pow(onscreen_dispval, DISPVAL_POWER) / dispval_base, SHRINK_MAX_RATE);
                dm.fontsize /= shrink_rate;
                dm.pakku.desc.push(`已缩小 ${shrink_rate.toFixed(2)} 倍：原弹幕密度为 ${onscreen_dispval.toFixed(1)}`);
                stats.modified_shrink++;
            }
            // update stats
            stats.num_max_dispval = Math.max(stats.num_max_dispval, onscreen_dispval);
            //dm.content = `[${onscreen_dispval.toFixed(0)}]${dm.content}`;
        }
        if (config.SCROLL_THRESHOLD) {
            if (dm.mode === 4 || dm.mode === 5) {
                let width = get_width_if_exceeds(dm.content, dm.fontsize, config.SCROLL_THRESHOLD);
                if (width > config.SCROLL_THRESHOLD) {
                    let prefix = dm.mode === 4 ? '↓' : '↑';
                    dm.mode = 1;
                    dm.content = prefix + dm.content;
                    dm.pakku.disp_str = prefix + dm.pakku.disp_str;
                    dm.pakku.desc.push(`转换为滚动弹幕：宽度为 ${width.toFixed(0)} px`);
                    stats.modified_scroll++;
                }
            }
        }
        // it seems that hot colorful danmus may have style issues, so we remove the colorful if hot
        if (dm.extra.proto_attr && (dm.extra.proto_attr & 4)) {
            dm.extra.proto_colorful = 0;
        }
        stats.num_max_combo = Math.max(stats.num_max_combo, dm.pakku.peers.length);
    }
    // dropped danmakus are assigned a special weight; delete them here
    if (stats.deleted_dispval) {
        out_danmus = out_danmus.filter(dm => dm.weight !== WEIGHT_DROPPED);
    }
    if (config.TAKEOVER_AIJUDGE) {
        for (let d of out_danmus)
            d.weight = Math.max(d.weight, 10);
    }
    stats.num_onscreen_danmu += out_danmus.length;
    return {
        objs: out_danmus,
        extra: input_chunk ? input_chunk.extra : {},
    };
}

var userscript_template = "(()=>{let fn_before = [];let fn_after = [];let fn_view = [];function reg_tweak_fn(list) {return (callback, timing=0) => {if(typeof callback !== 'function')throw new Error('callback argument is not a function');list.push([timing, async (chunk, env) => {let ret = callback(chunk, env);if(ret instanceof Promise)ret = await ret;return ret;}]);};}const tweak_before_pakku = reg_tweak_fn(fn_before);const tweak_after_pakku = reg_tweak_fn(fn_after);const tweak_proto_view = reg_tweak_fn(fn_view);function fix_dispstr(chunk) {for(let obj of chunk.objs) {let text = obj.content;if(obj.mode===7 && obj.content[0]==='[') {try {text = JSON.parse(obj.content)[4];} catch(e) {}}obj.pakku.disp_str = text.replace(/([\\r\\n\\t])/g,'').trim();}}let env_base = {};onmessage = async (e) => {let [serial, payload] = e.data;try {if(payload.type==='init') {install_callbacks(tweak_before_pakku, tweak_after_pakku, tweak_proto_view);fn_before = fn_before.sort((a, b) => a[0] - b[0]);fn_after = fn_after.sort((a, b) => a[0] - b[0]);fn_view = fn_view.sort((a, b) => a[0] - b[0]);if(payload.env_base)env_base = payload.env_base;postMessage({serial: serial, error: null, output: {n_before: fn_before.length,n_after: fn_after.length,n_view: fn_view.length,}});}else if(payload.type==='pakku_before') {let env = {...env_base, ...payload.env};for(let [timing, fn] of fn_before)await fn(payload.chunk, env);postMessage({serial: serial, error: null, output: payload.chunk});}else if(payload.type==='pakku_after') {let env = {...env_base, ...payload.env};for(let [timing, fn] of fn_after)await fn(payload.chunk, env);fix_dispstr(payload.chunk);postMessage({serial: serial, error: null, output: payload.chunk});}else if(payload.type==='proto_view') {let env = {...env_base, ...payload.env};for(let [timing, fn] of fn_view)await fn(payload.view, env);postMessage({serial: serial, error: null, output: payload.view});}else {postMessage({serial: serial, error: 'unknown type '+payload.type});}} catch(err) {postMessage({serial: serial, error: err});}};})();function install_callbacks(tweak_before_pakku, tweak_after_pakku, tweak_proto_view) {/* MAIN */}";

// @ts-ignore
const USERSCRIPT_TEMPLATE = userscript_template;
class UserscriptWorker {
    script;
    worker;
    terminated;
    init_error;
    queue_serial;
    queue_callback;
    n_before;
    n_after;
    n_view;
    constructor(script) {
        this.script = script || '';
        this.worker = new Worker(URL.createObjectURL(new Blob([
            USERSCRIPT_TEMPLATE.replace('/* MAIN */', this.script + '\n'),
        ], { type: 'text/javascript' })));
        this.terminated = false;
        this.init_error = null;
        this.queue_callback = new Map();
        this.queue_serial = 0;
        this.n_before = 0;
        this.n_after = 0;
        this.n_view = 0;
        this.worker.onerror = (e) => {
            console.error('pakku userscript: UNCAUGHT ERROR', e);
            this.init_error = e;
            for (let [resolve, reject] of this.queue_callback.values()) {
                reject(e);
            }
            this.queue_callback.clear();
        };
        this.worker.onmessage = (e) => {
            let serial = e.data.serial;
            if (!this.queue_callback.has(serial)) {
                console.error('pakku userscript: BAD SERIAL', e);
                return;
            }
            let [resolve, reject] = this.queue_callback.get(serial);
            this.queue_callback.delete(serial);
            if (this.terminated && this.queue_callback.size === 0)
                this.worker.terminate();
            if (e.data.error)
                reject(e.data.error);
            else
                resolve(e.data.output);
        };
    }
    exec(arg) {
        if (this.init_error)
            return Promise.reject(this.init_error);
        console.log('pakku userscript: exec', arg.type);
        return new Promise((resolve, reject) => {
            let serial = ++this.queue_serial;
            this.worker.postMessage([serial, arg]);
            this.queue_callback.set(serial, [resolve, reject]);
        });
    }
    terminate() {
        if (this.terminated)
            return;
        this.terminated = true;
        // make sure to terminate only when all tasks are done to avoid missing view responses
        if (this.queue_callback.size === 0)
            this.worker.terminate();
        // else: terminate until all tasks are done in this.worker.onmessage
    }
    async init(env_base) {
        let { n_before, n_after, n_view } = await this.exec({ type: 'init', env_base: env_base });
        this.n_before = n_before;
        this.n_after = n_after;
        this.n_view = n_view;
        return n_before + n_after + n_view;
    }
    sancheck_chunk_output(chunk) {
        if (!chunk
            || !chunk.objs
            || !chunk.extra
            || !Array.isArray(chunk.objs)
            || typeof chunk.extra !== 'object') {
            throw new Error(`userscript returned invalid value: ${JSON.stringify(chunk)}`);
        }
    }
}

function make_p(s) {
    let elem = document.createElement('p');
    elem.textContent = s;
    return elem;
}
function make_a(s, url) {
    let elem = document.createElement('a');
    elem.href = url;
    elem.target = '_blank';
    elem.textContent = s;
    return elem;
}
function make_elem(tagname, classname) {
    let elem = document.createElement(tagname);
    elem.className = classname;
    return elem;
}
function proc_mode(mode) {
    switch (mode) {
        case 1:
            return '|←';
        // 2,3: ???
        case 4:
            return '↓↓';
        case 5:
            return '↑↑';
        case 6:
            return 'R→';
        case 7:
            return '**';
        case 8:
            return '[CODE]';
        case 9:
            return '[BAS]';
        default:
            return '[MODE' + mode + ']';
    }
}
function proc_rgb(x) {
    return [
        Math.floor(x / 256 / 256),
        Math.floor(x / 256) % 256,
        x % 256
    ];
}
// http://www.nbdtech.com/Blog/archive/2008/04/27/Calculating-the-Perceived-Brightness-of-a-Color.aspx
function get_L(r, g, b) {
    return Math.sqrt(r * r * .241 +
        g * g * .691 +
        b * b * .068) / 256;
}
function _fix2(a) {
    return a < 10 ? '0' + a : '' + a;
}
function format_date(x) {
    return _fix2(x.getFullYear() % 100) + '/' + (x.getMonth() + 1) + '/' + x.getDate();
}
function format_datetime(x) {
    return format_date(x) + ' ' + x.getHours() + ':' + _fix2(x.getMinutes());
}
function format_duration(d) {
    d = d | 0; // to int
    return d < 3600 ?
        (Math.floor(d / 60) + ':' + _fix2(d % 60)) :
        (Math.floor(d / 3600) + ':' + _fix2(Math.floor((d % 3600) / 60)) + ':' + _fix2(d % 60));
}
function zero_array(len) {
    let x = new Array(len);
    for (let i = 0; i < len; i++)
        x[i] = 0;
    return x;
}
function parse_time(time, fallback) {
    let res = /^(?:(\d+):)?(\d+):(\d{2})$/.exec(time);
    if (!res)
        return fallback;
    if (res[1])
        return parseInt(res[1]) * 3600 + parseInt(res[2]) * 60 + parseInt(res[3]);
    else
        return parseInt(res[2]) * 60 + parseInt(res[3]);
}
function sleep_ms(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}
function wait_until_success(fn, interval_ms, tries) {
    if (fn())
        return;
    else if (tries > 0) {
        setTimeout(function () {
            wait_until_success(fn, interval_ms, tries - 1);
        }, interval_ms);
    }
}

const DETAILS_MAX_TIMEDELTA_MS = 10 * 1000;
const GRAPH_DENSITY_POWER = .8;
const GRAPH_DENSITY_SCALE = .667;
const GRAPH_ALPHA = .7;
const COLOR_FILL_WITHDEL = '#ff9999';
const COLOR_FILL_BEF = '#ffbbaa';
const COLOR_FILL_AFT = '#bbaaff';
const COLOR_LINE_WITHDEL = '#cc0000';
const COLOR_LINE_BEF = '#664400';
const COLOR_LINE_AFT = '#1111cc';
let MAX_FLUCT_LINES = 16;
function fluctlight_cleanup() {
    for (let elem of window.root_elem.querySelectorAll('.pakku-fluctlight')) {
        elem.remove();
    }
    if (window.graph_observer) {
        window.graph_observer.disconnect();
        window.graph_observer = null;
    }
    if (window.details_observer) {
        window.details_observer.disconnect();
        window.details_observer = null;
    }
    window.fluctlight_highlight = null;
}
function inject_fluctlight_graph(bar_elem, _version, cvs_container_elem_for_v2) {
    const SEEKBAR_PADDING = _version === 1 ? 6 : 0;
    const DPI = Math.min(window.devicePixelRatio, 2);
    const HEIGHT_CSS = 300, HEIGHT = HEIGHT_CSS * DPI;
    let WIDTH = Math.round(DPI * (bar_elem.clientWidth - SEEKBAR_PADDING));
    bar_elem.dataset['pakku_cache_width'] = '-1';
    let canvas_elem = document.createElement('canvas');
    canvas_elem.className = 'pakku-fluctlight pakku-fluctlight-graph';
    let ctx = canvas_elem.getContext('2d');
    let progress_elem;
    if (_version === 4 || _version === 2)
        progress_elem = bar_elem;
    else if (_version === 3)
        progress_elem = bar_elem.querySelector('.squirtle-progress-detail');
    else if (_version === 1)
        progress_elem = bar_elem.querySelector('.bilibili-player-video-progress-detail');
    else
        progress_elem = null;
    if (!progress_elem) {
        console.log('! fluctlight cannot find progress_elem');
        return;
    }
    let fix_canvas_position_fn = null;
    let v4_detail_elem = bar_elem.querySelector('.bpx-player-progress-popup');
    if (_version === 4 && v4_detail_elem) {
        fix_canvas_position_fn = function () {
            let v_offset = v4_detail_elem.clientHeight;
            if (v_offset > 0)
                canvas_elem.style.top = (-HEIGHT_CSS - 18 - v_offset) + 'px';
        };
    }
    let DURATION = 0;
    function getduration() {
        let total_time_elem = window.root_elem.querySelector('.bilibili-player-video-time-total, .squirtle-video-time-total, .bpx-player-ctrl-time-duration');
        DURATION = total_time_elem ? parse_time(total_time_elem.textContent, 0) : 0;
        if (!DURATION) {
            let video_elem = window.root_elem.querySelector('video');
            DURATION = video_elem ? video_elem.duration : 0;
        }
        if (DURATION > 0)
            DURATION = DURATION * 1000 + 1000;
    }
    getduration();
    const LINE_WIDTH = 1.5 * DPI;
    const LABEL_FONT_SIZE = 9 * DPI;
    const MIN_LABEL_SEP = LABEL_FONT_SIZE / 2;
    function draw_line_and_label(w, labels) {
        ctx.globalAlpha = .85;
        ctx.font = `bold ${LABEL_FONT_SIZE}px consolas, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = 'white';
        ctx.lineWidth = .75 * DPI;
        // draw lines
        for (let [h, color] of labels) {
            let h_d = HEIGHT - density_transform(h);
            ctx.fillStyle = color;
            ctx.strokeRect(w, h_d, LINE_WIDTH, h);
            ctx.fillRect(w, h_d, LINE_WIDTH, h);
        }
        // draw labels
        let labels_to_draw = [[0, '', '']];
        ctx.lineWidth = DPI;
        labels.reverse(); // calc from bottom to top
        for (let [h, color] of labels) {
            let h_t = density_transform(h);
            if (h_t - labels_to_draw[labels_to_draw.length - 1][0] > MIN_LABEL_SEP)
                labels_to_draw.push([h_t, '' + Math.ceil(h), color]);
        }
        labels_to_draw.reverse(); // draw from top to bottom
        for (let [h_t, label, color] of labels_to_draw) {
            if (label) {
                let h_d = HEIGHT - h_t + DPI;
                ctx.fillStyle = color;
                ctx.strokeText(label, w + 6, h_d);
                ctx.fillText(label, w + 6, h_d);
            }
        }
    }
    function density_transform(d) {
        return d <= .001 ? -2 : DPI * (1 + Math.pow(d, GRAPH_DENSITY_POWER) * GRAPH_DENSITY_SCALE);
    }
    let den_withdel = [], den_bef = [], den_aft = [];
    let graph_img = null;
    function block(time) {
        return Math.round(time * WIDTH / DURATION);
    }
    function fix_line_visibility(arr_above, arr_below, idx) {
        let delta = arr_above[idx] - arr_below[idx];
        // slightly adjust the graph to make sure the line is visible
        if (delta > .05 && delta < 2) {
            arr_above[idx] = arr_below[idx] + 2;
        }
    }
    function recalc() {
        if (bar_elem.dataset['pakku_cache_width'] === '' + WIDTH)
            return true;
        if (WIDTH <= 0) { // maybe the dom is not fully initialized yet
            console.log('pakku fluctlight: got invalid WIDTH =', WIDTH);
            return false;
        }
        bar_elem.dataset['pakku_cache_width'] = '' + WIDTH;
        console.log('pakku fluctlight: recalc dispval graph with WIDTH =', WIDTH);
        function apply_dispval(arr) {
            return function (p) {
                let dispv = dispval(p);
                let time_ms = p.time_ms;
                arr[Math.max(0, block(time_ms))] += dispv;
                arr[block(time_ms + DISPVAL_TIME_THRESHOLD) + 1] -= dispv;
            };
        }
        den_withdel = zero_array(WIDTH);
        den_bef = zero_array(WIDTH);
        den_aft = zero_array(WIDTH);
        getduration();
        if (!DURATION) {
            console.log('pakku fluctlight: failed to get video duration');
            return false;
        }
        for (let d of window.danmus) {
            if (d.pakku.peers.length) {
                apply_dispval(den_aft)(d);
                d.pakku.peers.forEach(apply_dispval(den_bef));
            }
        }
        for (let d of window.danmus_del) {
            apply_dispval(den_withdel)(d);
        }
        for (let w = 1; w < WIDTH; w++) {
            den_withdel[w] += den_withdel[w - 1];
            den_bef[w] += den_bef[w - 1];
            den_aft[w] += den_aft[w - 1];
        }
        // density in px
        let den_withdel_t = zero_array(WIDTH), den_bef_t = zero_array(WIDTH), den_aft_t = zero_array(WIDTH);
        for (let w = 0; w < WIDTH; w++) {
            den_withdel[w] += den_bef[w];
            den_withdel_t[w] = density_transform(den_withdel[w]);
            den_bef_t[w] = density_transform(den_bef[w]);
            den_aft_t[w] = density_transform(den_aft[w]);
            fix_line_visibility(den_bef_t, den_aft_t, w);
            fix_line_visibility(den_withdel_t, den_bef_t, w);
        }
        // now draw the canvas
        let offscreen_canvas = document.createElement('canvas');
        offscreen_canvas.width = WIDTH;
        offscreen_canvas.height = HEIGHT + 2; // +2px to make the bottom line invisible
        let ctx = offscreen_canvas.getContext('2d');
        ctx.lineWidth = .75 * DPI;
        function draw_path(den_array, clear, line_color, fill_color) {
            ctx.beginPath();
            ctx.moveTo(-2, HEIGHT + 2);
            ctx.lineTo(-2, HEIGHT - den_array[0]);
            for (let w = 0; w < WIDTH; w++)
                ctx.lineTo(w, HEIGHT - den_array[w]);
            ctx.lineTo(WIDTH + 2, HEIGHT - den_array[WIDTH - 1]);
            ctx.lineTo(WIDTH + 2, HEIGHT + 2);
            ctx.closePath();
            if (clear) {
                ctx.globalCompositeOperation = 'destination-out';
                ctx.globalAlpha = 1;
                ctx.fill();
            }
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = GRAPH_ALPHA;
            ctx.strokeStyle = line_color;
            ctx.fillStyle = fill_color;
            ctx.fill();
            ctx.stroke();
        }
        draw_path(den_withdel_t, false, COLOR_LINE_WITHDEL, COLOR_FILL_WITHDEL);
        draw_path(den_bef_t, true, COLOR_LINE_BEF, COLOR_FILL_BEF);
        draw_path(den_aft_t, true, COLOR_LINE_AFT, COLOR_FILL_AFT);
        graph_img = offscreen_canvas;
        return true;
    }
    function redraw(hltime, hlheight) {
        let succ = recalc();
        if (fix_canvas_position_fn) {
            fix_canvas_position_fn();
        }
        canvas_elem.style.width = (WIDTH / DPI) + 'px';
        canvas_elem.width = WIDTH;
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        if (!succ)
            return;
        ctx.drawImage(graph_img, 0, 0, WIDTH, HEIGHT + 2);
        ctx.save();
        let hlblock = (hltime === undefined) ? undefined : block(hltime * 1000 + 1000); // bias 1000ms to compensate unbalanced shadow
        if (hlblock !== undefined) {
            // add gradient
            let GRALENGTH = 90 * DPI;
            let EDGESIZE = GRALENGTH * .9;
            let curblock = hlblock;
            if (hlblock < EDGESIZE)
                hlblock = EDGESIZE;
            else if (hlblock > WIDTH - EDGESIZE)
                hlblock = WIDTH - EDGESIZE;
            let gra = ctx.createLinearGradient(hlblock - GRALENGTH, 0, hlblock + GRALENGTH, 0);
            gra.addColorStop(0, 'rgba(255,255,255,0)');
            gra.addColorStop(.1, 'rgba(255,255,255,1)');
            gra.addColorStop(.9, 'rgba(255,255,255,1)');
            gra.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.globalCompositeOperation = 'destination-out';
            ctx.globalAlpha = .6;
            ctx.fillStyle = gra;
            ctx.fillRect(hlblock - GRALENGTH, hlheight === undefined ? 0 : (HEIGHT - hlheight * DPI), GRALENGTH * 2, HEIGHT);
            // highlight current time
            ctx.globalCompositeOperation = 'source-over';
            draw_line_and_label(curblock, [
                [den_withdel[curblock], COLOR_LINE_WITHDEL],
                [den_bef[curblock], COLOR_LINE_BEF],
                [den_aft[curblock], COLOR_LINE_AFT],
            ]);
        }
        ctx.restore();
    }
    redraw();
    window.fluctlight_highlight = redraw;
    canvas_elem.style.height = HEIGHT_CSS + 'px';
    canvas_elem.height = HEIGHT;
    canvas_elem.style.display = 'none';
    canvas_elem.style.position = 'absolute';
    canvas_elem.style.marginBottom = -HEIGHT_CSS + 'px';
    if (_version === 4)
        canvas_elem.style.top = (-HEIGHT_CSS - 108) + 'px';
    else if (_version === 3)
        canvas_elem.style.top = (-HEIGHT_CSS - 92) + 'px';
    else if (_version === 2)
        canvas_elem.style.bottom = (HEIGHT_CSS + 119) + 'px';
    else if (_version === 1) {
        canvas_elem.style.position = 'relative';
        canvas_elem.style.bottom = (HEIGHT_CSS + 120) + 'px';
        canvas_elem.style.marginBottom = '0';
    }
    if (_version === 4 || _version === 3)
        bar_elem.insertBefore(canvas_elem, bar_elem.firstChild);
    else if (_version === 2)
        cvs_container_elem_for_v2.insertBefore(canvas_elem, cvs_container_elem_for_v2.firstChild);
    else if (_version === 1)
        bar_elem.appendChild(canvas_elem);
    let time_elem = bar_elem.querySelector('.bilibili-player-video-progress-detail-time, .squirtle-progress-time, .bpx-player-progress-preview-time');
    // show or hide
    window.graph_observer = new MutationObserver(function (muts) {
        let bar_opened = (_version === 4 ?
            progress_elem.classList.contains('bpx-state-active') :
            _version === 3 ?
                progress_elem.style.display === 'block' :
                _version === 2 ?
                    progress_elem.classList.contains('bilibili-player-show') :
                    _version === 1 ?
                        progress_elem.style.display !== 'none' :
                        false);
        console.log('pakku fluctlight: graph observer, bar_opened =', bar_opened);
        if (bar_opened && canvas_elem.style.display === 'none') {
            canvas_elem.style.display = 'initial';
            // detect resize
            let width = Math.round(DPI * (bar_elem.clientWidth - SEEKBAR_PADDING));
            if (width && width !== WIDTH) {
                WIDTH = width;
            }
            if (fix_canvas_position_fn)
                fix_canvas_position_fn();
            if (time_elem)
                redraw(parse_time(time_elem.textContent, undefined));
            else
                redraw();
        }
        else if (!bar_opened && canvas_elem.style.display !== 'none') {
            canvas_elem.style.display = 'none';
            canvas_elem.style.width = '0px';
            canvas_elem.width = 0;
        }
    });
    window.graph_observer.observe(progress_elem, {
        attributes: true,
        attributeFilter: _version === 4 ? ['class'] : _version === 3 ? ['style'] : _version === 2 ? ['class'] : ['style']
    });
}
function inject_fluctlight_details(bar_elem, _version) {
    let fluct = document.createElement('div');
    fluct.className = 'pakku-fluctlight pakku-fluctlight-fluct';
    let time_elem = bar_elem.querySelector('.bilibili-player-video-progress-detail-time, .squirtle-progress-time, .bpx-player-progress-preview-time');
    let detail_elem = bar_elem.querySelector('.bilibili-player-video-progress-detail, .squirtle-progress-detail, .bpx-player-progress-popup');
    if (!time_elem) {
        console.log('! fluctlight cannot find time_elem');
        return;
    }
    if (!detail_elem) {
        console.log('! fluctlight cannot find detail_elem');
    }
    if (_version === 2)
        detail_elem = detail_elem.querySelector('.bilibili-player-video-progress-detail-container') || detail_elem;
    function to_dom(danmu) {
        let p = make_p(danmu.content);
        if (danmu.pakku.peers.length > 1)
            p.style.fontWeight = 'bold';
        return p;
    }
    function mode_prio(mode) {
        switch (mode) {
            case 4:
                return 1; //'↓↓'
            case 5:
                return 2; //'↑↑'
            case 7:
                return 3; //'**'
            case 1:
                return 4; //'|←'
            default:
                return 999;
        }
    }
    function sort_danmus() {
        let danmus = [];
        for (let d of window.danmus) {
            if (d.pakku.peers.length && d.pakku.peers[0].mode !== 8 /*code*/)
                danmus.push(d);
        }
        danmus.sort(function (a, b) {
            return a.time_ms - b.time_ms;
        });
        return danmus;
    }
    let D_tag = window.danmus; // handle D update
    let D_sorted = sort_danmus();
    function bisect_idx(time_ms) {
        let lo = 0, hi = D_sorted.length;
        while (lo < hi) {
            let mid = (lo + hi) >> 1;
            if (D_sorted[mid].time_ms < time_ms)
                lo = mid + 1;
            else
                hi = mid;
        }
        return lo;
    }
    // time
    window.details_observer = new MutationObserver(function (muts) {
        for (let mut of muts) {
            if (mut.addedNodes) {
                let time_str = mut.addedNodes[0].textContent;
                //console.log('pakku fluctlight: details', time_str);
                if (time_str === fluct.dataset['current_time'])
                    return;
                fluct.dataset['current_time'] = '' + time_str;
                fluct.style.height = '0';
                fluct.textContent = '';
                let time = parse_time(time_str, null);
                if (time === null)
                    return;
                let time_ms = time * 1000 + 1000; // bias 1000ms to make current danmaku visible in fluct list
                let danmus = [];
                if (window.danmus !== D_tag) { // recalc D_sorted if D is changed
                    D_tag = window.danmus;
                    D_sorted = sort_danmus();
                }
                for (let i = bisect_idx(time_ms - DETAILS_MAX_TIMEDELTA_MS); i < D_sorted.length; i++) {
                    let d = D_sorted[i];
                    if (d.time_ms > time_ms)
                        break;
                    danmus.push(d);
                }
                danmus = danmus.sort(function (a, b) {
                    return (a.pakku.peers.length - b.pakku.peers.length ||
                        mode_prio(b.pakku.peers[0].mode) - mode_prio(a.pakku.peers[0].mode) ||
                        a.time_ms - b.time_ms);
                }).slice(-MAX_FLUCT_LINES);
                for (let danmu of danmus) {
                    fluct.appendChild(to_dom(danmu));
                }
                let container_height = (danmus.length ? 6 + 16 * danmus.length : 0);
                fluct.style.height = container_height + 'px';
                if (_version === 3 || _version === 4) {
                    fluct.style.bottom = container_height + 'px';
                    fluct.style.marginBottom = (-container_height) + 'px';
                }
                else if (_version === 2) {
                    fluct.style.bottom = '0';
                }
                else {
                    fluct.style.bottom = (72 + container_height) + 'px';
                }
                if (window.fluctlight_highlight) {
                    window.fluctlight_highlight(time, container_height);
                }
            }
        }
    });
    window.details_observer.observe(time_elem, {
        childList: true
    });
    fluct.dataset['current_time'] = '';
    detail_elem.insertBefore(fluct, detail_elem.firstChild);
}
function inject_fluctlight() {
    fluctlight_cleanup();
    wait_until_success(function () {
        let seekbar_v4_elem = window.root_elem.querySelector('.bpx-player-progress-wrap');
        if (seekbar_v4_elem) {
            console.log('pakku injector: seekbar v4_elem', seekbar_v4_elem);
            inject_fluctlight_graph(seekbar_v4_elem, 4, null);
            inject_fluctlight_details(seekbar_v4_elem, 4);
            return true;
        }
        let seekbar_v3_elem = window.root_elem.querySelector('.squirtle-progress-wrap');
        if (seekbar_v3_elem) {
            console.log('pakku injector: seekbar v3_elem', seekbar_v3_elem);
            inject_fluctlight_graph(seekbar_v3_elem, 3, null);
            inject_fluctlight_details(seekbar_v3_elem, 3);
            return true;
        }
        let seekbar_v2_elem = window.root_elem.querySelector('.bilibili-player-video-progress');
        let seekbar_cvs_elem = window.root_elem.querySelector('.bilibili-player-video-control-top, .bpx-player-control-wrap .squirtle-controller, .bpx-player-control-wrap .bpx-player-progress-wrap');
        if (seekbar_v2_elem && seekbar_cvs_elem) {
            console.log('pakku injector: seekbar v2_elem', seekbar_v2_elem, 'cvs_elem', seekbar_cvs_elem);
            inject_fluctlight_graph(seekbar_v2_elem, 2, seekbar_cvs_elem);
            inject_fluctlight_details(seekbar_v2_elem, 2);
            return true;
        }
        if (seekbar_v2_elem) {
            console.log('pakku injector: seekbar v1_elem', seekbar_v2_elem);
            inject_fluctlight_graph(seekbar_v2_elem, 1, null);
            inject_fluctlight_details(seekbar_v2_elem, 1);
            return true;
        }
        return false;
    }, 400, 50);
}

function make_crc32_cracker() {
    const POLY = 0xedb88320;
    let crc32_table = new Uint32Array(256);
    function make_table() {
        for (let i = 0; i < 256; i++) {
            let crc = i;
            for (let _ = 0; _ < 8; _++) {
                if (crc & 1) {
                    crc = ((crc >>> 1) ^ POLY) >>> 0;
                }
                else {
                    crc = crc >>> 1;
                }
            }
            crc32_table[i] = crc;
        }
    }
    make_table();
    function update_crc(by, crc) {
        return ((crc >>> 8) ^ crc32_table[(crc & 0xff) ^ by]) >>> 0;
    }
    function compute(arr, init) {
        let crc = init || 0;
        for (let i = 0; i < arr.length; i++) {
            crc = update_crc(arr[i], crc);
        }
        return crc;
    }
    function make_rainbow(N) {
        let rainbow = new Uint32Array(N);
        for (let i = 0; i < N; i++) {
            let arr = [].slice.call(i.toString()).map(Number);
            rainbow[i] = compute(arr);
        }
        return rainbow;
    }
    console.time('pakku crc32: rainbow');
    let rainbow_0 = make_rainbow(100000);
    let five_zeros = Array(5).fill(0);
    let rainbow_1 = rainbow_0.map(function (crc) {
        return compute(five_zeros, crc);
    });
    let rainbow_pos = new Uint32Array(65537);
    let rainbow_hash = new Uint32Array(200000);
    function make_hash() {
        for (let i = 0; i < rainbow_0.length; i++) {
            rainbow_pos[rainbow_0[i] >>> 16]++;
        }
        for (let i = 1; i <= 65536; i++) {
            rainbow_pos[i] += rainbow_pos[i - 1];
        }
        for (let i = 0; i <= rainbow_0.length; i++) {
            let po = --rainbow_pos[rainbow_0[i] >>> 16];
            rainbow_hash[po << 1] = rainbow_0[i];
            rainbow_hash[po << 1 | 1] = i;
        }
    }
    function lookup(crc) {
        let results = [];
        let first = rainbow_pos[crc >>> 16], last = rainbow_pos[1 + (crc >>> 16)];
        for (let i = first; i < last; i++) {
            if (rainbow_hash[i << 1] === crc)
                results.push(rainbow_hash[i << 1 | 1]);
        }
        return results;
    }
    make_hash();
    console.timeEnd('pakku crc32: rainbow');
    function crack(maincrc, max_digit) {
        let results = [];
        maincrc = (~maincrc) >>> 0;
        let basecrc = 0xffffffff;
        for (let ndigits = 1; ndigits <= max_digit; ndigits++) {
            basecrc = update_crc(0x30, basecrc);
            if (ndigits < 6) {
                let first_uid = Math.pow(10, ndigits - 1), last_uid = Math.pow(10, ndigits);
                for (let uid = first_uid; uid < last_uid; uid++) {
                    if (maincrc === ((basecrc ^ rainbow_0[uid]) >>> 0)) {
                        results.push(uid);
                    }
                }
            }
            else {
                let first_prefix = Math.pow(10, ndigits - 6);
                let last_prefix = Math.pow(10, ndigits - 5);
                for (let prefix = first_prefix; prefix < last_prefix; prefix++) {
                    let rem = (maincrc ^ basecrc ^ rainbow_1[prefix]) >>> 0;
                    let items = lookup(rem);
                    for (let z of items) {
                        results.push(prefix * 100000 + z);
                    }
                }
            }
        }
        return results;
    }
    return crack;
}
let _crc32_cracker = null;
function crack_uidhash(uidhash, max_digit) {
    _crc32_cracker = _crc32_cracker || make_crc32_cracker();
    return _crc32_cracker(parseInt(uidhash, 16), max_digit);
}

const DANMU_SELECTOR = '.bilibili-danmaku, .b-danmaku:not(.b-danmaku-hide), .bili-dm, .bili-danmaku-x-show';
function make_panel_dom() {
    let dom = make_elem('div', 'pakku-panel');
    let dom_title = make_elem('p', 'pakku-panel-title');
    let dom_close = make_elem('button', 'pakku-panel-close');
    let dom_selectbar = make_elem('div', 'pakku-panel-selectbar');
    dom_close.type = 'button';
    dom_close.textContent = '×';
    dom_title.appendChild(dom_close);
    dom_title.appendChild(make_elem('span', 'pakku-panel-text'));
    dom_selectbar.appendChild(make_elem('span', 'pakku-panel-selectbar-left'));
    dom_selectbar.appendChild(make_elem('span', 'pakku-panel-selectbar-right'));
    dom_selectbar.appendChild(make_elem('span', 'pakku-panel-selectbar-content'));
    dom.appendChild(dom_title);
    dom.appendChild(dom_selectbar);
    dom.appendChild(make_elem('hr', ''));
    dom.appendChild(make_elem('div', 'pakku-insight-row'));
    dom.appendChild(make_elem('div', 'pakku-panel-desc'));
    dom.appendChild(make_elem('hr', 'pakku-for-desc'));
    dom.appendChild(make_elem('div', 'pakku-panel-peers'));
    dom.appendChild(make_elem('hr', 'pakku-for-footer'));
    dom.appendChild(make_elem('div', 'pakku-panel-footer text-fix'));
    return dom;
}
let _mem_info = {};
async function load_userinfo(uid, logger) {
    if (_mem_info[uid]) {
        return _mem_info[uid];
    }
    let res = await chrome.runtime.sendMessage(null, {
        type: 'xhr_proxy',
        url: 'https://api.bilibili.com/x/web-interface/card?type=json&mid=' + uid,
    });
    try {
        if (res.error || res.status !== 200)
            throw new Error('pakku panel: get sender info failed');
        res = JSON.parse(res.text);
    }
    catch (e) {
        logger.innerHTML = '';
        logger.appendChild(make_a(uid + ' 个人信息加载失败', '//space.bilibili.com/' + uid));
        throw e;
    }
    _mem_info[uid] = res;
    return res;
}
const UID_MAX_DIGIT = 10;
async function query_uid(uidhash, logger_container) {
    if (logger_container.dataset['_current_hash'] === uidhash)
        return;
    logger_container.dataset['_current_hash'] = uidhash;
    logger_container.textContent = '';
    let logger = document.createElement('div');
    logger_container.appendChild(logger);
    logger.textContent = uidhash + ' 正在获取 UID...';
    await sleep_ms(1);
    let uids = crack_uidhash(uidhash, UID_MAX_DIGIT);
    if (uids.length) {
        logger.textContent = '';
        for (let uid of uids) {
            let subitem = document.createElement('p');
            subitem.textContent = uid + ' 正在加载个人信息...';
            logger.appendChild(subitem);
            let res = await load_userinfo(uid, subitem);
            let nickname, lv, exp, fans, sex;
            if (!res?.data?.card?.mid || !res?.data?.card?.level_info?.current_level) {
                subitem.remove();
                return;
            }
            try {
                nickname = res.data.card.name;
                lv = res.data.card.level_info.current_level;
                exp = res.data.card.level_info.current_exp;
                fans = res.data.card.fans;
                sex = { '男': '♂', '女': '♀' }[res.data.card.sex] || '〼';
            }
            catch (e) {
                subitem.textContent = '';
                subitem.appendChild(make_a(uid + ' 个人信息加载失败', '//space.bilibili.com/' + uid));
                throw e;
            }
            subitem.textContent = '';
            subitem.appendChild(make_a(uid + ' Lv' + lv + (exp ? ('(' + exp + ') ') : ' ') + sex + ' ' + (fans ? +fans + '★ ' : '') + nickname, '//space.bilibili.com/' + uid));
        }
    }
    else {
        logger.textContent = uidhash + ' UID 不存在';
    }
}
function extract_insight(s) {
    let ret = [];
    // note that s may be prefixed or suffixed `₍₎` or `[]` by pakku
    // jump to time (1:00:00), also include things like `7.30` because a few users do send danmus like this
    for (let pattern_jump of s.matchAll(/(?:^|[^a-zA-Z0-9日号天])(\d+)(?:(?:[:：.]|小?时)([0-5][0-9]))?(?:[:：.]|分钟?)([0-5][0-9])(?:$|[^a-zA-Z0-9分千万亿倍个天日月年元米+:：.])/g)) {
        let time_normalized = pattern_jump[2] ? `${pattern_jump[1]}:${pattern_jump[2]}:${pattern_jump[3]}` : `${pattern_jump[1]}:${pattern_jump[3]}`;
        let jump_s = parse_time(time_normalized, null);
        if (jump_s !== null) {
            let btn = document.createElement('button');
            btn.textContent = time_normalized;
            btn.onclick = function () {
                window.postMessage({
                    type: 'pakku_video_jump',
                    time: jump_s,
                });
            };
            ret.push(btn);
        }
    }
    // video reference (avxxxx or BVxxxxx)
    for (let pattern_video of s.matchAll(/(?:^|[^a-zA-Z0-9])([aA][vV][1-9]\d{2,}|BV[a-zA-Z0-9]{10})(?:$|[^a-zA-Z0-9])/g)) {
        let video_link = 'https://www.bilibili.com/video/' + (
        // avxxxx must be lowercase
        pattern_video[1].toLowerCase().startsWith('a') ? pattern_video[1].toLowerCase() : pattern_video[1]);
        let btn = document.createElement('button');
        btn.textContent = pattern_video[1];
        btn.onclick = function () {
            window.open(video_link);
        };
        ret.push(btn);
    }
    // user reference (@xxxx)
    for (let pattern_user of s.matchAll(/(?:^|[ ~,，.。《》、:：()（）…!！?？₎/\[\]]|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana})(@(?:[0-9a-zA-Zー_-]|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}){3,16})(?:$|[ @~,，.。《》、:：()（）…!！?？/₍\[\]])/ug)) {
        let user_link = 'https://search.bilibili.com/upuser?keyword=' + encodeURIComponent(pattern_user[1]);
        let btn = document.createElement('button');
        btn.textContent = pattern_user[1];
        btn.onclick = function () {
            window.open(user_link);
        };
        ret.push(btn);
    }
    return ret;
}
function guess_current_info_idx(infos) {
    if (infos.length <= 1)
        return 0;
    let cur_time_elem = window.root_elem.querySelector('.bpx-player-ctrl-time-current');
    let cur_time_ms = 1000 * (cur_time_elem ? parse_time(cur_time_elem.textContent, 0) : 0);
    let item = infos.map((info, idx) => [idx, info.time_ms]);
    item.sort((a, b) => Math.abs(a[1] - cur_time_ms) - Math.abs(b[1] - cur_time_ms));
    return item[0][0];
}
function inject_panel(list_elem, player_elem, config) {
    let panel_obj = document.createElement('div');
    panel_obj.style.display = 'none';
    panel_obj.appendChild(make_panel_dom());
    panel_obj.querySelector('.pakku-panel-close').addEventListener('click', function () {
        panel_obj.style.display = 'none';
    });
    panel_obj.addEventListener('mousewheel', function (e) {
        e.stopPropagation();
    });
    window.root_elem.ownerDocument.addEventListener('click', function (e) {
        if (!panel_obj.contains(e.target) && !list_elem.contains(e.target))
            panel_obj.style.display = 'none';
    });
    player_elem.appendChild(panel_obj);
    function extract_danmaku_text(elem) {
        let subs = [];
        for (let sub of elem.childNodes) {
            let clz = sub.className || '';
            if (!clz.includes('-icon') // bad example: 'bili-danmaku-x-high-icon'
                && !clz.includes('-tip') // bad example: 'bili-danmaku-x-up-tip'
            ) {
                // some good examples:
                // - 'bili-danmaku-x-dm-vip'
                // - '' (text node or plain <span>)
                subs.push(sub.textContent);
            }
        }
        return subs.join('');
    }
    function show_panel(dminfo, floating = false) {
        let dm_ultralong = dminfo.str.length > 498, dm_str = dminfo.str.replace(/([\r\n\t])/g, '').trim(), text_container = panel_obj.querySelector('.pakku-panel-text'), selectbar = {
            bar: panel_obj.querySelector('.pakku-panel-selectbar'),
            content: panel_obj.querySelector('.pakku-panel-selectbar-content'),
            left: panel_obj.querySelector('.pakku-panel-selectbar-left'),
            right: panel_obj.querySelector('.pakku-panel-selectbar-right'),
        }, insight_row = panel_obj.querySelector('.pakku-insight-row'), desc_container = panel_obj.querySelector('.pakku-panel-desc'), peers_container = panel_obj.querySelector('.pakku-panel-peers'), footer_container = panel_obj.querySelector('.pakku-panel-footer');
        panel_obj.style.display = 'block';
        text_container.textContent = '';
        desc_container.innerHTML = '';
        peers_container.innerHTML = '';
        footer_container.textContent = '';
        footer_container.dataset['_current_hash'] = '';
        let infos = [];
        let accurate_guess = false;
        // the list might be sorted in a wrong way, so let's guess the index
        if (typeof dminfo.index === 'number'
            && window.danmus[dminfo.index]
            && (dm_ultralong ? window.danmus[dminfo.index].pakku.disp_str.startsWith(dm_str) : window.danmus[dminfo.index].pakku.disp_str === dm_str)) {
            accurate_guess = true;
            infos = [window.danmus[dminfo.index]];
        }
        else {
            for (let d of window.danmus)
                if ((dm_ultralong ? d.pakku.disp_str.startsWith(dm_str) : d.pakku.disp_str === dm_str))
                    infos.push(d);
        }
        console.log('pakku panel: show panel', infos, accurate_guess ? '(accurate)' : '(searched)');
        function redraw_ui(idx) {
            if (idx < 0)
                idx += infos.length;
            else if (idx >= infos.length)
                idx -= infos.length;
            let info = infos[idx];
            text_container.textContent = info.content;
            selectbar.bar.style.display = infos.length > 1 ? 'block' : 'none';
            selectbar.content.textContent = (idx + 1) + '/' + infos.length + ' [' + format_duration(info.time_ms / 1000) + ']';
            selectbar.left.onclick = function () {
                redraw_ui(idx - 1);
            };
            selectbar.right.onclick = function () {
                redraw_ui(idx + 1);
            };
            desc_container.textContent = '';
            for (let desc of info.pakku.desc) {
                desc_container.appendChild(make_p(desc));
            }
            insight_row.textContent = '';
            for (let btn of extract_insight(info.content)) {
                insight_row.appendChild(btn);
            }
            peers_container.textContent = '';
            for (let p of info.pakku.peers) {
                let self = document.createElement('div');
                let color = proc_rgb(p.color);
                self.style.color = 'rgb(' + color[0] + ',' + color[1] + ',' + color[2] + ')';
                self.classList.add(get_L(color[0], color[1], color[2]) > .5 ? 'black' : 'white');
                self.appendChild(make_p(proc_mode(p.mode) + ' ' + p.content));
                self.appendChild(make_p(p.pakku.sim_reason + ' ' + p.sender_hash + ' ' + (p.time_ms / 1000).toFixed(1) + 's ' + p.fontsize + 'px '
                    + 'W' + p.weight + ' ' + format_datetime(new Date(p.sendtime * 1000))));
                self.addEventListener('mouseover', function () {
                    void query_uid(p.sender_hash, footer_container);
                });
                peers_container.appendChild(self);
            }
            if (info.pakku.peers[0])
                void query_uid(info.pakku.peers[0].sender_hash, footer_container);
        }
        if (infos.length) {
            redraw_ui(guess_current_info_idx(infos));
        }
        else {
            text_container.textContent = dminfo.str;
            desc_container.appendChild(make_p('找不到弹幕详情'));
        }
        peers_container.scrollTo(0, 0);
        if (floating)
            panel_obj.classList.add('pakku-floating');
        else
            panel_obj.classList.remove('pakku-floating');
    }
    if (window.panel_listener) {
        list_elem.removeEventListener('click', window.panel_listener);
        console.log('pakku panel: removing previous hook listener');
    }
    list_elem.addEventListener('click', window.panel_listener = function (e) {
        let dm_obj = e.target;
        if (!dm_obj.classList.contains('dm-info-row') && !dm_obj.classList.contains('danmaku-info-row'))
            dm_obj = dm_obj.parentElement;
        if (dm_obj && dm_obj.classList.contains('danmaku-info-row') && dm_obj.getAttribute('dmno')) // ver 2
            show_panel({
                str: dm_obj.querySelector('.danmaku-info-danmaku').title,
                index: parseInt(dm_obj.getAttribute('dmno')),
            });
        if (dm_obj && dm_obj.classList.contains('dm-info-row') && dm_obj.getAttribute('data-index')) // ver 3
            show_panel({
                str: dm_obj.querySelector('.dm-info-dm').title,
                index: parseInt(dm_obj.getAttribute('data-index')),
            });
    });
    let danmaku_stage = player_elem.querySelector('.bilibili-player-video-danmaku, .bpx-player-row-dm-wrap');
    if (danmaku_stage && config.TOOLTIP_KEYBINDING) {
        let hover_counter = 0;
        danmaku_stage.addEventListener('mouseover', function (e) {
            if (!player_elem.classList.contains('__pakku_pointer_event'))
                return;
            hover_counter++;
            let target = e.target.closest(DANMU_SELECTOR);
            if (target) {
                show_panel({ str: extract_danmaku_text(target) }, true);
            }
        });
        danmaku_stage.addEventListener('mouseout', function (e) {
            if (--hover_counter < 0)
                hover_counter = 0;
            if (hover_counter === 0 && panel_obj.classList.contains('pakku-floating'))
                panel_obj.style.display = 'none';
        });
        danmaku_stage.addEventListener('click', function (e) {
            if (!player_elem.classList.contains('__pakku_pointer_event'))
                return;
            let target = e.target.closest(DANMU_SELECTOR);
            if (target) {
                show_panel({ str: extract_danmaku_text(target) });
                e.stopPropagation();
            }
            player_elem.classList.remove('__pakku_pointer_event');
        });
        window.root_elem.ownerDocument.addEventListener('keydown', function (e) {
            if ((e.key === 'Control' || e.key === 'Meta') && !e.repeat) {
                if (!e.target.closest('input,textarea')) { // only enter selection mode if not in input box
                    hover_counter = 0;
                    player_elem.classList.add('__pakku_pointer_event');
                }
            }
            else if (!e.ctrlKey && !e.metaKey) { // fix ctrl key state
                player_elem.classList.remove('__pakku_pointer_event');
                if (panel_obj.classList.contains('pakku-floating'))
                    panel_obj.style.display = 'none';
            }
        });
        window.root_elem.ownerDocument.addEventListener('keyup', function (e) {
            if (e.key === 'Control' || e.key === 'Meta') {
                player_elem.classList.remove('__pakku_pointer_event');
                if (panel_obj.classList.contains('pakku-floating'))
                    panel_obj.style.display = 'none';
            }
        });
        // after the webpage lost focus, `keyup` event might not be dispatched
        window.root_elem.ownerDocument.defaultView.addEventListener('blur', function () {
            player_elem.classList.remove('__pakku_pointer_event');
        });
    }
}

function show_danmu_list() {
    let list_switch_elem = window.root_elem.querySelector('.danmaku-box .bui-collapse-wrap-folded .bui-collapse-header, #danmukuBox .bui-collapse-wrap-folded .bui-collapse-header');
    console.log('pakku injector: list_switch_elem', list_switch_elem);
    if (list_switch_elem) {
        setTimeout(function () {
            list_switch_elem.click();
        }, 500);
    }
}
function disable_danmu() {
    let danmu_switch = window.root_elem.querySelector('.bilibili-player-video-danmaku-switch input[type=checkbox], .bpx-player-dm-switch input[type=checkbox]');
    if (danmu_switch) {
        console.log('pakku injector: danmu_switch', danmu_switch);
        if (danmu_switch.checked)
            danmu_switch.click();
    }
    else { // legacy
        let disable_elem = window.root_elem.querySelector('.bilibili-player-video-btn-danmaku');
        console.log('pakku injector: disable_elem LEGACY', disable_elem);
        if (disable_elem && !disable_elem.classList.contains('video-state-danmaku-off'))
            disable_elem.click();
    }
}
function trigger_mouse_event(node, eventType) {
    let e = new MouseEvent(eventType, { bubbles: true, cancelable: true });
    node.dispatchEvent(e);
}
function reload_danmu_magic(key) {
    function proceed(date_picker) {
        let elem = document.createElement('span');
        elem.className = 'js-action __pakku_injected';
        elem.dataset['action'] = 'changeDay';
        elem.dataset['timestamp'] = '' + (86400 + key * 86400);
        elem.style.display = 'none';
        date_picker.appendChild(elem);
        console.log('pakku reload danmu: proceed');
        trigger_mouse_event(elem, 'mousedown');
        trigger_mouse_event(elem, 'mouseup');
        trigger_mouse_event(elem, 'click');
        elem.remove();
    }
    let date_picker = window.root_elem.querySelector('.player-auxiliary-danmaku-date-picker-day-content, .bilibili-player-danmaku-date-picker-day-content');
    if (date_picker)
        proceed(date_picker);
    else {
        let history_btn = window.root_elem.querySelector('.player-auxiliary-danmaku-btn-history, .bpx-player-dm-btn-history, .bilibili-player-danmaku-btn-history');
        if (!history_btn) {
            console.log('pakku reload danmu: IGNORE request because danmu list not found');
            return;
        }
        console.log('pakku reload danmu: activating date picker with', history_btn);
        history_btn.click();
        history_btn.click();
        date_picker = window.root_elem.querySelector('.player-auxiliary-danmaku-date-picker-day-content, .bpx-player-date-picker-day-content, .bilibili-player-danmaku-date-picker-day-content');
        if (date_picker)
            proceed(date_picker);
        else { // maybe danmaku panel is hidden
            show_danmu_list();
            let tries_left = 10;
            function try_find() {
                history_btn.click();
                history_btn.click();
                date_picker = window.root_elem.querySelector('.player-auxiliary-danmaku-date-picker-day-content, .bpx-player-date-picker-day-content, .bilibili-player-danmaku-date-picker-day-content');
                if (date_picker)
                    proceed(date_picker);
                else {
                    if (--tries_left > 0)
                        setTimeout(try_find, 350);
                    else
                        console.log('pakku reload danmu: FAILED to find date picker');
                }
            }
            setTimeout(try_find, 1000);
        }
    }
}

function combine_into_d(chunks) {
    let D = [];
    let keys_sorted = Array.from(chunks.keys()).sort((a, b) => a - b);
    for (let k of keys_sorted)
        D.push(...chunks.get(k).objs);
    return D;
}
function do_inject(chunks, chunks_del, config) {
    let try_left = 50;
    function try_inject() {
        // try to find the player element
        window.root_elem = document.querySelector('.bilibili-player-area, .bpx-player-primary-area');
        // maybe player is in an iframe
        for (let frame of document.querySelectorAll('iframe')) {
            try {
                if (!window.root_elem)
                    window.root_elem = frame.contentDocument.querySelector('.bilibili-player, .bilibili-player-area, .bpx-player-primary-area');
            }
            catch (e) { } // maybe cross-domain
        }
        let pakku_tag_elem = window.root_elem;
        let list_elem = null;
        // maybe player is not ready yet
        if (window.root_elem) {
            window.root_elem = window.root_elem.closest('body');
            try_left = Math.min(try_left, 15); // don't wait too long for list_elem
            list_elem = window.root_elem.querySelector('.bilibili-player-danmaku, .player-auxiliary-danmaku-wrap, .bpx-player-dm');
        }
        if (!window.root_elem || !list_elem) {
            if (--try_left > 0) {
                setTimeout(try_inject, 200);
                return;
            }
            else if (!window.root_elem) {
                console.log('pakku injector: root_elem not found');
                return;
            }
            // else root_elem && !list_elem
            //   maybe an embedded player, just continue
        }
        window.danmus = combine_into_d(chunks);
        window.danmus_del = combine_into_d(chunks_del);
        if (pakku_tag_elem.classList.contains('__pakku_injected')) {
            console.log('pakku injector: already injected');
            // cleanup old cached value
            let fluct_cache = window.root_elem.querySelector('[data-pakku_cache_width]');
            if (fluct_cache)
                fluct_cache.dataset['pakku_cache_width'] = '';
            // fluctlight need to be reinjected in case player is reloaded
            if (config.FLUCTLIGHT) {
                inject_fluctlight();
            }
            return;
        }
        else {
            console.log('pakku injector: root_elem', window.root_elem, 'tag_elem', pakku_tag_elem);
            pakku_tag_elem.classList.add('__pakku_injected');
        }
        if (config.TOOLTIP) {
            let player_elem = pakku_tag_elem;
            console.log('pakku injector: list_elem', list_elem, 'player_elem', player_elem);
            if (player_elem)
                inject_panel(list_elem || document.createElement('div'), player_elem, config);
        }
        if (config.AUTO_DISABLE_DANMU) {
            disable_danmu();
        }
        if (config.AUTO_DANMU_LIST) {
            show_danmu_list();
        }
        if (config.FLUCTLIGHT) {
            inject_fluctlight();
        }
        window.reload_danmu_magic = reload_danmu_magic;
    }
    try_inject();
}

const BADGE_DOWNLOADING = '↓';
const BADGE_PROCESSING = '...';
const BADGE_ERR_NET = 'NET!';
const BADGE_ERR_JS = 'JS!';
function _filter_aslongas(x, fn) {
    let i = 0;
    while (i < x.length && fn(x[i]))
        i++;
    return x.slice(0, i);
}
let _throttle_timer = null;
let _throttle_fn = null;
function perform_throttle(fn) {
    if (_throttle_timer)
        _throttle_fn = fn;
    else {
        fn();
        _throttle_timer = setTimeout(() => {
            _throttle_timer = null;
            if (_throttle_fn) {
                _throttle_fn();
                _throttle_fn = null;
            }
        }, 100);
    }
}
// https://stackoverflow.com/questions/37228285/uint8array-to-arraybuffer
function u8array_to_arraybuffer(array) {
    return array.buffer.slice(array.byteOffset, array.byteLength + array.byteOffset);
}
class Scheduler {
    ingress;
    egresses;
    config;
    stats;
    ongoing_stats;
    tabid;
    start_ts;
    chunks_in;
    clusters;
    chunks_out;
    chunks_deleted;
    num_chunks;
    combine_started;
    failed;
    cleaned_up;
    pool;
    userscript;
    userscript_init;
    prefetch_data;
    constructor(ingress, config, tabid) {
        this.ingress = ingress;
        this.egresses = [];
        this.config = config;
        this.stats = new MessageStats('message', '', '');
        this.ongoing_stats = new Stats();
        this.tabid = tabid;
        this.start_ts = 0;
        this.chunks_in = new Map();
        this.clusters = new Map();
        this.chunks_out = new Map();
        this.chunks_deleted = new Map();
        this.num_chunks = 0;
        this.combine_started = new Set();
        this.failed = false;
        this.cleaned_up = false;
        this.pool = new WorkerPool(config.COMBINE_THREADS);
        this.userscript = config.USERSCRIPT ? new UserscriptWorker(config.USERSCRIPT) : null;
        this.userscript_init = null;
        this.prefetch_data = null;
    }
    write_failing_stats(prompt, e, badge) {
        let msg = `${prompt}\n${e.message}\n\nStacktrace:\n${e.stack}\n\nIngress:\n${JSON.stringify(this.ingress)}`;
        this.stats = new MessageStats('error', badge, msg).notify(this.tabid);
        console.error('pakku scheduler: GOT EXCEPTION', e);
        this.failed = true;
        this.try_serve_egress();
    }
    write_cur_message_stats() {
        const throttled = () => {
            if (this.stats.type === 'message') { // skip if error or done
                let status_line = this.num_chunks ? '正在处理弹幕' : '正在下载弹幕';
                let num_finished = this.chunks_out.size;
                let num_combine_started = this.combine_started.size;
                let num_downloaded = this.chunks_in.size;
                let badge = this.num_chunks ? BADGE_PROCESSING : BADGE_DOWNLOADING;
                let prompt = `${status_line}（${num_finished}/${num_combine_started}/${num_downloaded}）`;
                this.stats = new MessageStats('message', badge, prompt).notify(this.tabid);
            }
        };
        perform_throttle(throttled);
    }
    add_egress(egress, callback) {
        if (this.cleaned_up)
            egress.wait_finished = false;
        console.log('pakku scheduler: route ingress =', this.ingress, 'egress =', egress);
        this.egresses.push([egress, callback]);
        this.try_serve_egress();
    }
    async try_start_combine(segidx) {
        if (this.failed)
            return;
        if (this.combine_started.has(segidx))
            return; // working or finished
        let chunk = this.chunks_in.get(segidx);
        let next_chunk = segidx === this.num_chunks ? { objs: [], extra: {} } : this.chunks_in.get(segidx + 1);
        if (!chunk || !next_chunk)
            return; // not ready
        this.combine_started.add(segidx);
        let max_next_time = chunk.objs.length ? chunk.objs[chunk.objs.length - 1].time_ms + 1000 * this.config.THRESHOLD : 0;
        let next_chunk_filtered = {
            objs: _filter_aslongas(next_chunk.objs, obj => obj.time_ms < max_next_time),
            extra: next_chunk.extra,
        };
        let res;
        try {
            if (chunk.objs.length) {
                res = await this.pool.exec([chunk, next_chunk_filtered, this.config]);
                console.log('pakku scheduler: got combine result', segidx, res.clusters.length);
            }
            else {
                res = {
                    clusters: [],
                    stats: new Stats(),
                };
                console.log('pakku scheduler: got combine result', segidx, '(skipped)');
            }
        }
        catch (e) {
            this.write_failing_stats(`合并分片 ${segidx} 时出错`, e, BADGE_ERR_JS);
            return;
        }
        this.clusters.set(segidx, res.clusters.map(c => ({
            peers: c.peers_ptr.map(([idx, reason]) => ({
                ...chunk.objs[idx],
                pakku: {
                    sim_reason: reason,
                },
            })),
            desc: c.desc,
            chosen_str: c.chosen_str,
        })));
        this.ongoing_stats.update_from(res.stats);
        void this.try_start_postproc(segidx);
        void this.try_start_postproc(segidx + 1);
    }
    async try_start_postproc(segidx) {
        if (this.failed)
            return;
        if (this.chunks_out.has(segidx))
            return; // finished
        let chunk = this.chunks_in.get(segidx);
        let clusters = this.clusters.get(segidx);
        let prev_clusters = this.clusters.get(segidx - 1);
        if (!clusters || !prev_clusters)
            return; // not ready
        let chunk_out;
        try {
            chunk_out = post_combine(clusters, prev_clusters, chunk, this.config, this.ongoing_stats);
        }
        catch (e) {
            this.write_failing_stats(`后处理分片 ${segidx} 时出错`, e, BADGE_ERR_JS);
            return;
        }
        if (this.userscript && this.userscript.n_after) {
            try {
                let t1 = +new Date();
                chunk_out = await this.userscript.exec({ type: 'pakku_after', chunk: chunk_out, env: { segidx: segidx } });
                this.userscript.sancheck_chunk_output(chunk_out);
                let t2 = +new Date();
                this.ongoing_stats.userscript_time_ms += Math.ceil(t2 - t1);
            }
            catch (e) {
                this.write_failing_stats(`处理分片 ${segidx} 后执行用户脚本时出错`, e, BADGE_ERR_JS);
                return;
            }
        }
        this.chunks_out.set(segidx, chunk_out);
        console.log('pakku scheduler: got chunks out', segidx, chunk_out.objs.length);
        this.write_cur_message_stats();
        this.try_serve_egress();
    }
    try_serve_egress() {
        if (this.failed) {
            for (let [_egress, callback] of this.egresses) {
                callback(null);
            }
            this.egresses = [];
            return;
        }
        if (!this.cleaned_up && this.num_chunks && this.num_chunks === this.chunks_out.size)
            this.do_cleanup();
        this.egresses = this.egresses.filter(([egress, callback]) => {
            let res = perform_egress(egress, this.num_chunks, this.config.GLOBAL_SWITCH ? this.chunks_out : this.chunks_in);
            if (res === MissingData)
                return true; // keep in queue
            else {
                console.log('pakku scheduler: served egress', egress);
                callback({ data: res });
                return false; // remove from queue
            }
        });
    }
    finish() {
        console.log('pakku scheduler: all finished');
        this.ongoing_stats.parse_time_ms = +new Date() - this.start_ts - this.ongoing_stats.download_time_ms;
        this.ongoing_stats.notify(this.tabid, this.config);
        this.stats = this.ongoing_stats;
        setTimeout(() => {
            this.calc_chunk_deleted();
            if (this.config.GLOBAL_SWITCH && !this.config.SKIP_INJECT) {
                do_inject(this.chunks_out, this.chunks_deleted, this.config);
            }
        }, 300); // delay ui injection to improve player responsiveness
    }
    calc_chunk_deleted() {
        let out_danmu_ids = new Set();
        for (let chunk of this.chunks_out.values()) {
            for (let dr of chunk.objs) {
                out_danmu_ids.add(dr.id);
                for (let dp of dr.pakku.peers)
                    out_danmu_ids.add(dp.id);
            }
        }
        this.chunks_deleted.clear();
        for (let [idx, chunk_in] of this.chunks_in) {
            let chunk_del = {
                objs: [],
                extra: chunk_in.extra,
            };
            for (let d of chunk_in.objs) {
                if (!out_danmu_ids.has(d.id))
                    chunk_del.objs.push(d);
            }
            this.chunks_deleted.set(idx, chunk_del);
        }
    }
    do_cleanup() {
        this.cleaned_up = true;
        if (this.stats.type === 'message') {
            this.finish();
        }
        for (let e of this.egresses) {
            // in unusual cases (e.g., when we guessed the number of chunks wrong), the player may request chunks we don't have
            // since we are finished, there is no chance to wait for them, so we should serve an empty response instead of hanging forever
            e[0].wait_finished = false;
        }
        this.clusters.clear(); // to free some RAM
        setTimeout(() => {
            this.pool.terminate();
            if (this.userscript)
                this.userscript.terminate();
        }, 1500); // delay destroying web workers to fix view req race and improve performance
    }
    async init_worker_pool() {
        let wasm_resp = await fetch(chrome.runtime.getURL('/assets/similarity-gen.wasm'));
        let wasm_mod = await wasm_resp.arrayBuffer();
        await this.pool.spawn([wasm_mod]);
    }
    async init_userscript() {
        if (!this.userscript)
            return;
        let fn = async () => {
            try {
                await this.userscript.init({
                    ingress: this.ingress,
                    segidx: null,
                    config: this.config,
                });
            }
            catch (e) {
                this.write_failing_stats('初始化用户脚本时出错', e, BADGE_ERR_JS);
                return;
            }
        };
        if (!this.userscript_init)
            this.userscript_init = fn();
        return this.userscript_init;
    }
    async start() {
        this.write_cur_message_stats();
        if (this.prefetch_data && this.prefetch_data.guessed_chunks && this.prefetch_data.guessed_chunks < this.pool.pool_size)
            this.pool.pool_size = this.prefetch_data.guessed_chunks;
        await Promise.all([
            this.init_worker_pool(),
            this.init_userscript(),
        ]);
        this.start_ts = +new Date();
        try {
            await perform_ingress(this.ingress, async (idx, chunk) => {
                console.log('pakku scheduler: got ingress chunk', idx, chunk.objs.length);
                if (this.userscript && this.userscript.n_before) {
                    try {
                        let t1 = +new Date();
                        chunk = await this.userscript.exec({ type: 'pakku_before', chunk: chunk, env: { segidx: idx } });
                        this.userscript.sancheck_chunk_output(chunk);
                        let t2 = +new Date();
                        this.ongoing_stats.userscript_time_ms += Math.ceil(t2 - t1);
                    }
                    catch (e) {
                        this.write_failing_stats(`处理分片 ${idx} 前执行用户脚本时出错`, e, BADGE_ERR_JS);
                        return;
                    }
                }
                chunk.objs.sort((a, b) => a.time_ms - b.time_ms);
                this.chunks_in.set(idx, chunk);
                this.ongoing_stats.num_total_danmu += chunk.objs.length;
                this.write_cur_message_stats();
                void this.try_start_combine(idx - 1);
                void this.try_start_combine(idx);
            }, this.prefetch_data);
        }
        catch (e) {
            this.write_failing_stats('下载弹幕时出错', e, BADGE_ERR_NET);
            return;
        }
        this.num_chunks = this.chunks_in.size;
        this.ongoing_stats.download_time_ms = +new Date() - this.start_ts;
        console.log('pakku scheduler: download finished, total chunks =', this.num_chunks);
        this.write_cur_message_stats();
        void this.try_start_combine(this.num_chunks);
        this.clusters.set(0, []); // pad a pseudo cluster before the first one for the `prev_clusters` arg
        void this.try_start_postproc(1);
    }
    async modify_proto_view() {
        await this.init_userscript();
        let view_req = this.prefetch_data.view;
        if (this.userscript && this.userscript.n_view) {
            let view;
            try {
                view = await protoapi_get_view(view_req);
            }
            catch (e) {
                this.write_failing_stats('下载 view 时出错', e, BADGE_ERR_NET);
                return view_req;
            }
            if (this.userscript.terminated) { // normally shouldn't happen, but possible when network is too slow
                console.log('pakku userscript: worker terminated, skip proto_view');
                return view_req;
            }
            try {
                let t1 = +new Date();
                view = await this.userscript.exec({ type: 'proto_view', view: view, env: {} });
                let view_ab = u8array_to_arraybuffer(protoapi_encode_view(view));
                let t2 = +new Date();
                this.ongoing_stats.userscript_time_ms += Math.ceil(t2 - t1);
                // cache the result so it will be available even if this.userscript has been cleaned up
                this.prefetch_data.view = new Promise((resolve) => resolve(view_ab));
                this.userscript.n_view = 0;
                return view_ab;
            }
            catch (e) {
                this.write_failing_stats(`执行 view 用户脚本时出错`, e, BADGE_ERR_JS);
                return view_req;
            }
        }
        else {
            return view_req;
        }
    }
}
let scheduler = null;
function ingress_equals(a, b) {
    // @ts-ignore
    return Object.keys(a).filter(k => k !== 'is_magicreload').every(k => a[k] === b[k]);
}
function handle_task(ingress, egress, callback, config, tabid) {
    if (scheduler && ingress_equals(scheduler.ingress, ingress)) {
        scheduler.config = config;
        scheduler.add_egress(egress, callback);
    }
    else {
        scheduler = new Scheduler(ingress, config, tabid);
        scheduler.add_egress(egress, callback);
        void scheduler.start();
    }
}
function handle_proto_view(ingress, view_url, config, tabid) {
    if (scheduler && ingress_equals(scheduler.ingress, ingress)) {
        scheduler.config = config;
        if (!scheduler.prefetch_data)
            scheduler.prefetch_data = protoapi_get_prefetch(ingress, view_url);
    }
    else {
        scheduler = new Scheduler(ingress, config, tabid);
        scheduler.prefetch_data = protoapi_get_prefetch(ingress, view_url);
        void scheduler.start();
    }
    return scheduler.modify_proto_view();
}

async function process_local(ingress, egress, config, tabid) {
    let perform = function () {
        return new Promise((resolve) => {
            handle_task(ingress, egress, resolve, config, tabid);
        });
    };
    return await perform();
}
async function userscript_sandbox(script) {
    let w = null;
    try {
        w = new UserscriptWorker(script);
        let tot_number = await w.init(null);
        return { error: null, total: tot_number };
    }
    catch (e) {
        let stack = e.stack || `at ${e.filename}:${e.lineno}:${e.colno}`;
        return { error: `${e.message || '未知错误'}\n\n${stack}` };
    }
    finally {
        if (w)
            w.worker.terminate();
    }
}

function get_player_blacklist() {
    try {
        let j = JSON.parse(window.localStorage.getItem('bpx_player_profile'));
        if (!j) // possibly in another domain
            j = {
                blockList: [],
                dmSetting: { status: false },
            };
        if (!j.dmSetting.status) // blacklist disabled
            j.blockList = [];
        let extra = JSON.parse(window.localStorage.getItem('pakku_extra_blacklist') || '[]');
        j.blockList.push(...extra);
        let ret = (j.blockList
            .filter(item => item.opened && [0, 1].includes(item.type))
            .map(item => [item.type === 1, item.filter])
            .filter(item => {
            if (item[0]) {
                try {
                    new RegExp(item[1]);
                }
                catch (e) {
                    return false;
                }
            }
            return true;
        }));
        console.log('pakku injected: got player blacklist', ret);
        return ret;
    }
    catch (e) {
        console.error('pakku injected: cannot get player blacklist', e);
        return [];
    }
}
let tabid = null;
let local_config = null;
let unreg_userscript = true;
function _really_get_local_config(is_pure_env) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            type: 'get_local_config',
            is_pure_env: is_pure_env,
        }, (res) => {
            if (res.error) {
                reject('in background script: ' + res.error);
            }
            else {
                resolve(res.result);
            }
        });
    });
}
async function get_local_config(is_pure_env = false) {
    if (!local_config) {
        ({ tabid, local_config } = await _really_get_local_config(is_pure_env));
        local_config.BLACKLIST = local_config.BLACKLIST.length ? get_player_blacklist() : [];
        if (localStorage.getItem('pakku_extra_userscript'))
            local_config.USERSCRIPT = local_config.USERSCRIPT + '\n\n' + localStorage.getItem('pakku_extra_userscript');
        // storage cleanup
        window.onbeforeunload = function () {
            if (unreg_userscript)
                void remove_state([`STATS_${tabid}`, `USERSCRIPT_${tabid}`]);
            else
                void remove_state([`STATS_${tabid}`]);
            // in case of page refresh: clear the badge
            try {
                chrome.runtime.sendMessage({ type: 'update_badge', tabid: tabid, text: null })
                    .catch(() => { });
            }
            catch (e) { }
        };
    }
    return local_config;
}
void get_local_config();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ping') {
        sendResponse({ error: null });
    }
    else if (msg.type === 'refresh') {
        unreg_userscript = false;
        window.location.reload();
    }
    else if (msg.type === 'dump_result') {
        let s = scheduler;
        if (!s) {
            sendResponse({
                error: '当前标签没有弹幕处理结果',
            });
        }
        else {
            s.config = {
                ...s.config,
                GLOBAL_SWITCH: msg.switch,
            };
            s.add_egress(msg.egress, (resp) => {
                if (!resp)
                    sendResponse({
                        error: `处理结果为 ${resp}`,
                    });
                else if (typeof resp.data === 'string')
                    try {
                        sendResponse({
                            error: null,
                            text: resp.data,
                            ingress: s.ingress,
                        });
                    }
                    catch (e) {
                        alert(`无法传输弹幕处理结果：\n${e.message}`);
                    }
                else
                    sendResponse({
                        error: `处理结果为 ${resp.data.constructor.name}`,
                    });
            });
        }
    }
    else if (msg.type === 'reload_danmu') {
        local_config = null;
        if (window.reload_danmu_magic)
            window.reload_danmu_magic(msg.key);
    }
    else {
        console.log('pakku injected: unknown chrome message', msg.type);
    }
});
function is_bilibili(origin) {
    return origin.endsWith('.bilibili.com') || origin.endsWith('//bilibili.com');
}
let ext_domain = chrome.runtime.getURL('');
if (ext_domain.endsWith('/'))
    ext_domain = ext_domain.slice(0, -1);
function is_proto_view(x) {
    // ts is too weak to inference this, let's add a type guard to teach it
    return x[1].type === 'proto_view';
}
window.addEventListener('message', async function (event) {
    if (is_bilibili(event.origin) && event.data.type == 'pakku_ping') {
        event.source.postMessage({
            type: 'pakku_pong',
        }, event.origin);
    }
    else if (is_bilibili(event.origin) && event.data.type == 'pakku_ajax_request') {
        console.log('pakku injected: got ajax request', event.data.url);
        let sendResponse = (resp) => {
            event.source.postMessage({
                type: 'pakku_ajax_response',
                url: event.data.url,
                resp: resp,
            }, event.origin);
        };
        url_finder.protoapi_img_url = window.localStorage.getItem('wbi_img_url');
        url_finder.protoapi_sub_url = window.localStorage.getItem('wbi_sub_url');
        let url = url_finder.find(event.data.url);
        if (!url) {
            console.log('pakku injected: url not matched:', event.data.url);
            sendResponse(null);
            return;
        }
        if (!local_config) {
            try {
                local_config = await get_local_config();
            }
            catch (e) {
                console.error('pakku injected: cannot get local config', e);
                if (tabid) {
                    let msg = `读取配置时出错\n${e.message || e}\n\nStacktrace:\n${e.stack || '(null)'}\n\nIngress:\n${JSON.stringify(url[0])}`;
                    new MessageStats('error', BADGE_ERR_JS, msg).notify(tabid);
                }
                sendResponse(null);
                return;
            }
        }
        if (!local_config.GLOBAL_SWITCH &&
            !(url[0].type === 'proto_seg' && url[0].is_magicreload) // still process magic reload requests to avoid HTTP 400
        ) {
            console.log('pakku injected: SKIPPED because global switch off');
            sendResponse(null);
            return;
        }
        if (is_proto_view(url)) {
            handle_proto_view(url[0], event.data.url, local_config, tabid)
                .then((ab) => {
                sendResponse({
                    data: new Uint8Array(ab),
                });
            });
            return;
        }
        handle_task(url[0], url[1], sendResponse, local_config, tabid);
    }
    else if (event.origin === ext_domain && event.data.type === 'pakku_userscript_sandbox_request') {
        let res = await userscript_sandbox(event.data.script);
        event.source.postMessage({
            type: 'pakku_userscript_sandbox_result',
            result: res,
        }, event.origin);
    }
    else if (event.origin === ext_domain && event.data.type === 'pakku_process_local_request') {
        let config = await get_local_config(true);
        config.GLOBAL_SWITCH = true;
        let res = await process_local(event.data.ingress, event.data.egress, config, tabid);
        event.source.postMessage({
            type: 'pakku_process_local_result',
            result: res,
        }, event.origin);
    }
}, false);
