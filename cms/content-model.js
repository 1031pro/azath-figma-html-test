(function(root){
  const api = {
    defaults: {siteName:'ゆ〜かり整骨院', title:'ゆ〜かり整骨院｜採用情報', description:'', locale:'ja_JP'},
    tags(value){ return [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,、\n]/)).map(x=>String(x).trim()).filter(Boolean))]; },
    complete(content){
      content.pages=content.pages || [{id:"recruit",title:"採用ページ",slug:"recruit",template:"recruit",body:"",listed:true,seoTitle:"",seoDescription:""}];
      content.settings={...this.defaults,...content.settings};
      content.articles=(content.articles || []).map(a=>({...a,category:String(a.category || '').trim(),categories:this.tags(a.categories || a.category),tags:this.tags(a.tags),seoTitle:a.seoTitle || '',seoDescription:a.seoDescription || ''}));
      content.taxonomies={categories:[],tags:[],...content.taxonomies};
      content.archives=content.archives || [];
      content.importedIds=[...new Set(content.importedIds || [])];
      return content;
    },
    categories(article) {const names=this.tags(article.categories || article.category);return names.length ? names : ['未分類'];},
    safeHttp(value) {try {const url=new URL(value);return ['https:','http:'].includes(url.protocol) ? url.href : '';}catch{return '';}},
    catalog(content,kind) {
      if(kind==='archive')return (content.archives || []).map(item=>({...item,name:item.title,description:item.description ?? item.body ?? ''}));
      const key=kind==='category' ? 'categories' : 'tags';
      const terms=(content.taxonomies?.[key] || []).map(term=>({...term}));
      this.taxonomy(content.articles,kind).forEach((items,name)=>{if(!terms.some(t=>t.name===name))terms.push({id:'local-'+name,name,description:'',seoTitle:'',seoDescription:''});});
      return terms;
    },
    termArticles(content,kind,term) {
      if(kind!=='archive')return this.filter(content.articles,kind,term.name);
      return content.articles.filter(a=>a.listed && (term.sourceType==='sitemap' || (term.sourceType==='date' ? (!a.sourceType || a.sourceType==='post') && String(a.date).startsWith(term.month) : a.sourceType===term.sourceType)));
    },
    termCollection(content,kind) {return kind==='archive' ? content.archives : content.taxonomies[kind==='category' ? 'categories' : 'tags'];},
    search(items,text,type) {const query=String(text || '').trim().toLocaleLowerCase('ja');return items.filter(item=>(!type || (item.sourceType || 'local')===type) && (!query || [item.title,item.body,item.sourceUrl,...(item.tags || []),...this.categories(item)].join(' ').toLocaleLowerCase('ja').includes(query)));},
    mergeImport(content,data,knownIds=[]) {
      this.complete(content);
      const seen=new Set([...content.importedIds,...knownIds,...content.pages.map(p=>p.id),...content.articles.map(p=>p.id)]);
      let added=0;
      for(const key of ['pages','articles'])for(const item of data[key] || []) {if(!seen.has(item.id)){content[key].push(structuredClone(item));seen.add(item.id);added++;}}
      for(const key of ['categories','tags'])for(const term of data.taxonomies?.[key] || [])if(!content.taxonomies[key].some(t=>t.id===term.id || t.name===term.name))content.taxonomies[key].push(structuredClone(term));
      content.importedIds=[...new Set([...content.importedIds,...(data.pages || []).map(p=>p.id),...(data.articles || []).map(p=>p.id),...knownIds])];
      for(const archive of data.archives || [])if(!content.archives.some(a=>a.id===archive.id))content.archives.push(structuredClone(archive));
      content.importInfo={source:data.source,fetchedAt:data.fetchedAt,coverage:structuredClone(data.coverage || {})};
      this.complete(content);return added;
    },
    union(draft,published) { return [...draft,...published.filter(p=>!draft.some(d=>d.id===p.id))]; },
    duplicateSlugs(items) {const names=items.filter(p=>p.listed).map(p=>p.slug);return new Set(names).size!==names.length;},
    suggestTags(text, existing=[]) {
      const ignored = new Set(['こと','もの','ため','よう','それ','これ','ところ','こちら','とき','とこ','さん','ます','です','ある','いる','なる','する','できる','ください','自分','場合','について','など','また','そして','から','まで','ので','その','この','今回','私たち','あなた',...this.tags(existing)]);
      const counts = new Map();
      const segments = new Intl.Segmenter('ja', {granularity:'word'}).segment(String(text || ''));
      for (const part of segments) {
        const word=part.segment.normalize('NFKC').trim();
        if (!part.isWordLike || [...word].length < 2 || ignored.has(word) || /^[\d\p{P}\p{S}]+$/u.test(word) || /^[ぁ-ゖー]+$/.test(word)) continue;
        counts.set(word,(counts.get(word)||0)+1);
      }
      return [...counts].filter(([,count])=>count>=2).sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0],'ja')).slice(0,20).map(([tag,count])=>({tag,count}));
    },
    taxonomy(articles,kind){
      const groups=new Map();
      articles.forEach(a=>(kind==='category' ? this.categories(a) : this.tags(a.tags)).forEach(name=>{if(!groups.has(name))groups.set(name,[]);groups.get(name).push(a);}));
      return groups;
    },
    filter(articles,kind,name){return articles.filter(a=>a.listed && (!kind || (kind==='category' ? this.categories(a).includes(name) : this.tags(a.tags).includes(name))));},
    head(doc,settings,page={}){
      doc.querySelectorAll('meta[name="description"],meta[name="robots"],meta[property^="og:"],link[rel="canonical"]').forEach(n=>n.remove());
      const title=page.title || settings.title || settings.siteName;
      const description=page.description ?? settings.description;
      doc.title=title;
      const meta=(key,value,property=false)=>{const el=doc.createElement('meta');el.setAttribute(property?'property':'name',key);el.content=value || '';doc.head.append(el);};
      meta('robots','noindex,nofollow');meta('description',description);
      for(const [key,value] of Object.entries({title,description,site_name:settings.siteName,type:page.type || 'website',locale:settings.locale}))meta('og:'+key,value,true);
    }
  };
  if(typeof module!=='undefined' && module.exports)module.exports=api; else root.CMS_CONTENT=api;
})(typeof window!=='undefined'?window:globalThis);
