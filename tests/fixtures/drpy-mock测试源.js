/*
@header({
  searchable: 2,
  filterable: 0,
  quickSearch: 0,
  title: 'mock测试源',
  '类型': '影视',
  lang: 'ds'
})
*/

// drpy-lite 自测规则：只打本地 mock 站（127.0.0.1:5901），不指向任何真实站点
var rule = {
    类型: '影视',
    title: 'mock测试源',
    host: 'http://127.0.0.1:5901',
    url: '/list/fyclass/fypage.html',
    searchUrl: '/search?wd=**',
    searchable: 2,
    quickSearch: 0,
    filterable: 0,
    play_parse: true,
    lazy: async function (flag, id, flags) {
        // 二次解析：不透明集 id → 直链
        if (/^https?:\/\//.test(id)) return {parse: 0, url: id};
        return {parse: 0, url: this.host + '/play/' + id};
    },
    class_name: '电影&剧集',
    class_url: 'movie&series',
    预处理: async () => [],
    一级: async function (tid, pg, filter, extend) {
        let {input, pdfa, pdfh, pd} = this;
        let html = await request(input);
        let d = [];
        let data = pdfa(html, '.mock-list&&li');
        data.forEach((it) => {
            let url = pd(it, 'a&&href');
            d.push({
                title: pdfh(it, 'a&&title'),
                img: pd(it, 'a&&data-original'),
                desc: pdfh(it, '.note&&Text') + '|v2',
                url: url,
                id: url.match(/\/detail\/(\d+)\.html/)?.[1] || '',
            });
        });
        return setResult(d);
    },
    二级: async function (ids) {
        let {input, pdfa, pdfh, pd} = this;
        let html = await request(input);
        let eps = pdfa(html, '.play-list&&a');
        // drpy-lite 测试：返回不透明集 id（真实 T4 生态如此），由 lazy 二次解析
        let playUrls = eps.map(a => {
            let href = pd(a, 'a&&href');
            let epId = (href.match(/\/play\/(.+\.m3u8)/) || [])[1] || href;
            return pdfh(a, 'a&&Text') + '$' + epId;
        }).join('#');
        return {
            vod_id: ids[0],
            vod_name: pdfh(html, '.title&&Text'),
            vod_actor: pdfh(html, '.actor&&Text'),
            vod_director: pdfh(html, '.director&&Text'),
            vod_content: pdfh(html, '.content&&Text'),
            vod_play_from: 'mock',
            vod_play_url: playUrls,
        };
    },
    搜索: async function (key, quick, pg) {
        let {input, pdfa, pdfh, pd} = this;
        let html = await request(input);
        let d = [];
        let data = pdfa(html, '.mock-list&&li');
        data.forEach((it) => {
            let url = pd(it, 'a&&href');
            d.push({
                title: pdfh(it, 'a&&title'),
                img: pd(it, 'a&&data-original'),
                desc: pdfh(it, '.note&&Text') + '|v2',
                url: url,
                id: url.match(/\/detail\/(\d+)\.html/)?.[1] || '',
            });
        });
        return setResult(d);
    },
};
