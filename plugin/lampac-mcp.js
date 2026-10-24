/* Lampa 3+ plugin: adds one AI-managed carousel to the main and category screens. */
(function () {
    'use strict';

    if (window.lampac_mcp_loaded) return;
    window.lampac_mcp_loaded = true;

    var script = document.currentScript;
    if (!script || !script.src) return;
    var base = script.src.replace(/\/plugin\.js(?:\?.*)?$/, '');
    if (base === script.src) return;

    function loadCollection(done) {
        var request = new XMLHttpRequest();
        request.open('GET', base + '/api/collection', true);
        request.timeout = 10000;
        request.onload = function () {
            if (request.status < 200 || request.status >= 300) return done({ title: 'AI picks', items: [] });
            try { done(JSON.parse(request.responseText)); }
            catch (error) { done({ title: 'AI picks', items: [] }); }
        };
        request.onerror = request.ontimeout = function () { done({ title: 'AI picks', items: [] }); };
        request.send();
    }

    function addRow() {
        if (!window.Lampa || !Lampa.ContentRows || !Lampa.ContentRows.add) return;
        if (Lampa.Manifest && Number(Lampa.Manifest.app_digital) < 300) return;

        Lampa.ContentRows.add({
            name: 'lampac_mcp_ai_picks',
            index: 50,
            screen: ['main', 'category'],
            call: function () {
                return function (complete) {
                    loadCollection(function (collection) {
                        var items = Array.isArray(collection.items) ? collection.items : [];
                        var results = items.map(function (item) {
                            var card = {};
                            for (var key in item) if (Object.prototype.hasOwnProperty.call(item, key)) card[key] = item[key];
                            card.source = 'tmdb';
                            card.media_type = item.media_type;
                            if (item.media_type === 'tv') card.name = item.title;
                            else card.title = item.title;
                            return card;
                        });
                        complete({ title: collection.title || 'AI picks', results: results, page: 1, total_pages: 1, total_results: results.length });
                    });
                };
            }
        });
    }

    if (window.appready) addRow();
    else if (window.Lampa && Lampa.Listener) Lampa.Listener.follow('app', function (event) {
        if (event && event.type === 'ready') addRow();
    });
})();
