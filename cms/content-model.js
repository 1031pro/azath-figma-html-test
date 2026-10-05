(function(root){
  const api = {
    defaults: {siteName:'ゆ〜かり整骨院', title:'ゆ〜かり整骨院｜採用情報', description:'', locale:'ja_JP'},
    tags(value){ return [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,、\n]/)).map(x=>String(x).trim()).filter(Boolean))]; },
    complete(content){
      content.pages=content.pages || [{id:"recruit",title:"採用ページ",slug:"recruit",template:"recruit",body:"",listed:true,seoTitle:"",seoDescription:""}];
      content.settings={...this.defaults,...content.settings};
      content.articles=(content.articles || []).map(a=>({...a,category:String(a.category || '').trim(),tags:this.tags(a.tags),seoTitle:a.seoTitle || '',seoDescription:a.seoDescription || ''}));
      return content;
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
      articles.forEach(a=>(kind==='category' ? [a.category || '未分類'] : this.tags(a.tags)).forEach(name=>{if(!groups.has(name))groups.set(name,[]);groups.get(name).push(a);}));
      return groups;
    },
    filter(articles,kind,name){return articles.filter(a=>a.listed && (!kind || (kind==='category' ? (a.category || '未分類')===name : this.tags(a.tags).includes(name))));},
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
