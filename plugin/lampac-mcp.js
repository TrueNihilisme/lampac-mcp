/* Lampa 3+ plugin: the main screen is built from AI-managed rows instead of the TMDB rows.
 *
 * The feed (/mcp/collection, module EX.Mcp) lists rows: title, kind, card style
 * (poster | wide) and TMDB ids. Card details (poster or 16:9 backdrop, localized title,
 * overview, rating) are fetched with Lampa's own TMDB source, i.e. through the same TMDB
 * proxy Lampa already uses, and cached on the device for a day. Rows of other plugins
 * (Lampa.ContentRows, e.g. "Continue watching") stay. Without rows, or when the feed is
 * unreachable, the usual TMDB main screen is shown. ES5 only: Tizen 4 / webOS 4 engines.
 */
(function () {
    'use strict';

    if (window.lampac_mcp_loaded) return;
    window.lampac_mcp_loaded = true;

    /* Tizen can run Lampa from its packaged file:// page; use this plugin's Lampac URL. */
    var BASE = (function () {
        var script = document.currentScript;
        if (!script) {
            var scripts = document.getElementsByTagName('script');
            for (var i = scripts.length - 1; i >= 0; i--) {
                if (scripts[i].src && scripts[i].src.indexOf('/custom/lampac-mcp.js') !== -1) {
                    script = scripts[i];
                    break;
                }
            }
        }
        if (script && script.src && script.src.indexOf('/custom/lampac-mcp.js') !== -1) {
            return script.src.replace(/\/custom\/lampac-mcp\.js.*$/, '');
        }
        if (/^https?:$/.test(window.location.protocol)) return window.location.origin;
        return '';
    })();
    if (!BASE) return;

    var endpoint = BASE + '/mcp/collection';
    var CACHE_KEY = 'lampac_mcp_tmdb_cache';
    var CACHE_TTL = 24 * 60 * 60 * 1000;
    var DETAILS_TIMEOUT = 8000;

    function loadCollection(done) {
        var request = new XMLHttpRequest();
        request.open('GET', endpoint, true);
        request.timeout = 10000;
        request.onload = function () {
            if (request.status < 200 || request.status >= 300) return done({ title: 'AI picks', items: [] });
            try { done(JSON.parse(request.responseText)); }
            catch (error) { done({ title: 'AI picks', items: [] }); }
        };
        request.onerror = request.ontimeout = function () { done({ title: 'AI picks', items: [] }); };
        request.send();
    }

    function readCache() {
        try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; }
        catch (e) { return {}; }
    }

    function writeCache(cache) {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); }
        catch (e) {}
    }

    /* Keep only what the card needs: the full TMDB answer is large and localStorage on TVs is small. */
    function pick(json) {
        return {
            title: json.title || json.name || '',
            original_title: json.original_title || json.original_name || '',
            backdrop_path: json.backdrop_path || '',
            poster_path: json.poster_path || '',
            vote_average: json.vote_average || 0,
            date: json.release_date || json.first_air_date || '',
            overview: json.overview || ''
        };
    }

    function details(item, cache, done) {
        var key = item.media_type + '_' + item.id;
        var hit = cache[key];
        if (hit && Date.now() - hit.t < CACHE_TTL) return done(hit.d);

        var finished = false;
        function finish(data) {
            if (finished) return;
            finished = true;
            if (data) cache[key] = { t: Date.now(), d: data };
            done(data || (hit ? hit.d : null));
        }
        setTimeout(function () { finish(null); }, DETAILS_TIMEOUT);

        try {
            Lampa.Api.sources.tmdb.get(item.media_type + '/' + item.id, {},
                function (json) { finish(json && json.id ? pick(json) : null); },
                function () { finish(null); });
        } catch (e) { finish(null); }
    }

    function card(item, d, wide) {
        var c = { id: item.id, source: 'tmdb', media_type: item.media_type };
        var title = (d && d.title) || item.title;
        if (item.media_type === 'tv') {
            c.name = title;
            c.original_name = d ? d.original_title : '';
            c.first_air_date = d ? d.date : '';
        }
        else {
            c.title = title;
            c.original_title = d ? d.original_title : '';
            c.release_date = d ? d.date : '';
        }
        if (d) {
            c.backdrop_path = d.backdrop_path;
            c.poster_path = d.poster_path;
            c.vote_average = d.vote_average;
            c.overview = d.overview;
        }

        /* Lampa 3 wide card (same as its own "In top" rows): 16:9 backdrop w780,
           title and overview drawn over it; falls back to the poster without a backdrop */
        if (wide) c.params = { style: { name: 'wide' } };
        return c;
    }

    /* One row of the main screen, in the shape Lampa's own TMDB rows have. */
    function buildRow(row, complete) {
        var items = Array.isArray(row.items) ? row.items : [];
        var wide = row.style === 'wide';
        var cache = readCache();
        var left = items.length;
        var found = [];

        function emit() {
            writeCache(cache);
            var results = [];
            for (var i = 0; i < items.length; i++) results.push(card(items[i], found[i], wide));
            var line = { title: row.title || 'AI picks', results: results, page: 1, total_pages: 1, total_results: results.length };
            if (wide) line.params = { items: { view: 3 } };
            complete(line);
        }

        if (!left) return emit();
        items.forEach(function (item, index) {
            details(item, cache, function (d) {
                found[index] = d;
                if (--left === 0) emit();
            });
        });
    }

    var PARTS_LIMIT = 6;
    var called = false;

    /* Replaces Lampa.Api.sources.tmdb.main. Returns the "load more rows" function Lampa expects
       synchronously, although the feed arrives later. */
    function install() {
        if (!window.Lampa || !Lampa.Api || !Lampa.Api.sources || !Lampa.Api.partNext) return;
        if (Lampa.Manifest && Number(Lampa.Manifest.app_digital) < 300) return;

        var tmdb = Lampa.Api.sources.tmdb;
        var original = tmdb.main;

        tmdb.main = function (params, oncomplite, onerror) {
            params = params || {};
            called = true;
            var delegate = null;
            var parts = null;
            var pending = null;

            function next(partLoaded, partEmpty) {
                if (delegate) return delegate(partLoaded, partEmpty);
                if (!parts) { pending = [partLoaded, partEmpty]; return; }
                Lampa.Api.partNext(parts, PARTS_LIMIT, partLoaded, partEmpty);
            }

            loadCollection(function (feed) {
                var rows = (Array.isArray(feed.rows) ? feed.rows : []).filter(function (row) {
                    return row && Array.isArray(row.items) && row.items.length;
                });
                if (!rows.length) delegate = original.call(tmdb, params, oncomplite, onerror);
                else {
                    parts = rows.map(function (row) {
                        return function (call) { buildRow(row, call); };
                    });
                    /* Rows of Lampa itself and other plugins ("Continue watching", recent and upcoming
                       episodes) go after ours, at the very bottom: the user's choice. */
                    var extra = [];
                    Lampa.ContentRows.call('main', params, extra);
                    parts = parts.concat(extra);
                    Lampa.Api.partNext(parts, PARTS_LIMIT, oncomplite, onerror);
                }
                if (pending) {
                    var wait = pending;
                    pending = null;
                    next(wait[0], wait[1]);
                }
            });

            return next;
        };

        /* Plugins arrive after Lampa is ready; on some devices (Android TV) the start screen is
           already built by then. If our main was not asked for, rebuild the visible main screen once. */
        setTimeout(function () {
            if (called) return;
            var active = Lampa.Activity && Lampa.Activity.active ? Lampa.Activity.active() : null;
            if (active && active.component === 'main') Lampa.Activity.refresh();
        }, 1500);
    }

    if (window.appready) install();
    else if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (event) {
        if (event && event.type === 'ready') install();
    });
})();
