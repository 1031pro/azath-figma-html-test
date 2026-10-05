"use strict";

(() => {
  const contentModel = typeof document === "undefined" ? require("./content-model.js") : window.CMS_CONTENT;
  const model = {
    safeUrl(value, baseUrl) {
      const text = String(value || "").trim();
      if (!text) return "";
      if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error("リンクに制御文字は使えません。");
      let url;
      try { url = new URL(text, baseUrl); } catch { throw new Error("リンク先の形式を確認してください。"); }
      if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) throw new Error("http・https・mailto・tel、またはページ内リンクを指定してください。");
      return text;
    },
    completeContent(content, defaults) {
      const result = structuredClone(content);
      result.values = { ...defaults.values, ...result.values };
      result.images = { ...structuredClone(defaults.images), ...result.images };
      result.links = { ...structuredClone(defaults.links), ...result.links };
      result.recruitButtons = content.recruitButtons === undefined
        ? defaults.recruitButtons.map((item) => ({ ...item, label: result.values[item.key] ?? item.label }))
        : structuredClone(content.recruitButtons);
      return contentModel.complete(result);
    },
  };
  if (typeof document === "undefined") { module.exports = model; return; }
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clone = (value) => structuredClone(value);
  const source = new DOMParser().parseFromString(window.FRAME_SOURCE, "text/html");
  const siteBase = new URL("site/", location.href).href;
  const fields = [];
  const groups = [];
  const initial = { values: {}, images: {}, links: {}, recruitButtons: [], faqs: [], articles: [], settings: { ...contentModel.defaults }, pages: [{id:"recruit",title:"採用ページ",slug:"recruit",template:"recruit",body:"",listed:true,seoTitle:"",seoDescription:""}] };
  const buttons = [];
  let state;
  let role = "admin";
  let selectedPage = "recruit";
  let db;
  let dirty = false;
  let revision = 0;
  let busy = false;
  let selectedGroup = "hero";
  let selectedArticle = null;
  let view = "pages";
  let previewMode = "draft";
  let device = "desktop";
  let articleMode = "draft";
  let articleRoute = "detail";
  let taxonomyKind = "";
  let taxonomyName = "";
  let pageScroll = 0;
  let toastTimer;
  let activeInline = null;

  // 元ページのスクリプトはプレビューで動かさず、編集対象を親画面で扱う。
  $$("script, dialog, .back-top", source).forEach((node) => node.remove());
  $$("*", source).forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
    });
  });
  const base = source.createElement("base");
  base.href = siteBase;
  source.head.prepend(base);
  const previewStyle = source.createElement("style");
  previewStyle.textContent = `
    html { scroll-behavior:auto !important; }
    .hero-area h1 { height:auto;min-height:64px;white-space:normal;overflow-wrap:anywhere; }
    .recruit-nav { display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr)); }
    .recruit-nav a { white-space:normal;overflow-wrap:anywhere;min-width:0; }
    .recruit-nav a:last-child { grid-column:auto; }
    .site-nav a { border:0;background:transparent;padding:0;font-size:12px;white-space:nowrap; }
    a[data-cms-original-tag="button"] { text-decoration:none;cursor:pointer; }
    a.booking, a.mail { display:inline-block;text-align:center; }
    a.phone, a.qr { display:block;text-align:center; }
    @media(max-width:700px){.hero-area h1{min-height:0}.recruit-nav{grid-template-columns:repeat(2,minmax(0,1fr))}}
  `;
  source.head.append(previewStyle);

  function plainText(node) {
    const copy = node.cloneNode(true);
    $$("br", copy).forEach((br) => br.replaceWith("\n"));
    return copy.textContent.trim();
  }

  function labelFor(node) {
    const label = {
      H1: "メイン見出し", H2: "セクション見出し", H3: "小見出し",
      P: "本文", DD: "募集要項", FIGCAPTION: "スケジュール",
      BUTTON: "ボタンの表示文", A: "メニューの表示文", FOOTER: "会社名・表記",
      SMALL: "受付時間・注記", B: "お問い合わせ案内", STRONG: "数値",
      SPAN: "項目名・コピー", DIV: "表示文",
    };
    if (node.tagName === "DD") return $("dt", node.parentElement).textContent;
    if (node.classList.contains("placeholder")) return "写真枠の説明";
    if (node.classList.contains("breadcrumb")) return "パンくずの表示文";
    return label[node.tagName] || "表示文";
  }

  function addGroup(id, label, root) {
    const group = { id, label, fields: [] };
    root.dataset.cmsGroup = id;
    groups.push(group);
    const selector = "h1,h2,h3,p,dd,figcaption,.placeholder,.stats span,.stats strong,.hero-copy span,button,nav a,footer,.breadcrumb,.contact-box b,.phone small";
    $$(selector, root).forEach((node, index) => {
      if (node.closest("#faq") && node.tagName !== "H2") return;
      if (node.tagName === "BUTTON" && !plainText(node)) return;
      const key = `${id}.text.${index}`;
      const ownText = node.tagName === "BUTTON" && !!node.children.length;
      const value = ownText
        ? [...node.childNodes].filter((part) => part.nodeType === 3).map((part) => part.textContent).join("").trim()
        : plainText(node);
      if (!value) return;
      node.dataset.cmsKey = key;
      const field = { key, group: id, type: "text", label: labelFor(node), value, ownText };
      fields.push(field);
      group.fields.push(field);
      initial.values[key] = value;
    });
    $$("img:not(.leaf-bg)", root).forEach((node, index) => {
      const key = `${id}.image.${index}`;
      node.dataset.cmsKey = key;
      const field = { key, group: id, type: "image", label: node.alt || "画像", src: node.getAttribute("src"), alt: node.alt };
      fields.push(field);
      group.fields.push(field);
      initial.images[key] = { src: field.src, alt: field.alt };
    });
    $$("a,button", root).forEach((node, index) => {
      const key = node.dataset.cmsKey || `${id}.button.${index}`;
      node.dataset.cmsButton = key;
      const link = { url: node.getAttribute("href") || "", target: node.getAttribute("target") === "_blank" ? "_blank" : "_self" };
      initial.links[key] = link;
      buttons.push({ key, group: id, field: fields.find((field) => field.key === key), label: plainText(node) || node.getAttribute("aria-label") || "画像のリンク" });
    });
  }

  addGroup("header", "共通ヘッダー・ロゴ", $("header", source));
  addGroup("hero", "メイン画像・見出し", $(".hero-area", source));
  $$("main > section", source).forEach((section, index) => {
    const label = $("h2", section)?.textContent || $("h3", section)?.textContent || "お問い合わせ";
    addGroup(section.id || `section-${index}`, label.slice(0, 35), section);
  });
  const footer = $("footer", source);
  footer.dataset.cmsGroup = "footer";
  const footerWrap = source.createElement("div");
  footer.replaceWith(footerWrap);
  footerWrap.append(footer);
  addGroup("footer", "共通フッター", footerWrap);
  footerWrap.replaceWith(footer);

  $$(".recruit-nav a", source).forEach((node, index) => {
    initial.recruitButtons.push({ id: `recruit-${index}`, key: node.dataset.cmsKey, label: plainText(node), url: node.getAttribute("href") || "", target: "_self" });
  });

  let category = "見学・応募について";
  [...$("#faq", source).children].forEach((node, index) => {
    if (node.tagName === "H3") category = node.textContent;
    if (node.tagName === "DETAILS") initial.faqs.push({
      id: `faq-${index}`, category, question: $("summary", node).textContent,
      answer: plainText($(".answer", node)),
    });
  });

  function createElement(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === "className") node.className = value;
      else if (key === "checked") node.checked = value;
      else if (key === "value") node.value = value;
      else if (key === "hidden") node.hidden = value;
      else node.setAttribute(key, value);
    });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, handler, className = "btn small") {
    const node = createElement("button", { type: "button", className }, text);
    node.addEventListener("click", handler);
    return node;
  }

  function toast(message) {
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 3800);
  }

  function confirmAction(message, actionLabel = "この内容で続ける") {
    return new Promise((resolve) => {
      const dialog = createElement("dialog", { className: "action-dialog", "aria-labelledby": "action-dialog-title" });
      const title = createElement("h2", { id: "action-dialog-title" }, "操作の確認");
      const controls = createElement("div", { className: "dialog-actions" });
      controls.append(
        button("戻る", () => dialog.close("cancel"), "btn"),
        button(actionLabel, () => dialog.close("confirm"), "btn primary"),
      );
      dialog.append(title, createElement("p", {}, message), controls);
      dialog.addEventListener("close", () => {
        const confirmed = dialog.returnValue === "confirm";
        dialog.remove();
        resolve(confirmed);
      }, { once: true });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  function status() {
    $("#save-status").textContent = busy ? "保存しています…" : dirty ? "未保存の変更あり" : state.savedAt ? `保存済み ${formatTime(state.savedAt)}` : "元ページから開始";
    $("#save").disabled = busy || role === "viewer";
    $("#publish").disabled = busy || role !== "admin";
    $$(".article-actions button").forEach((item) => { item.disabled = busy; });
    updateRoleControls();
  }

  function markDirty() {
    dirty = true;
    revision += 1;
    status();
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("frame-cms-demo-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("workspace");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function readState() {
    return new Promise((resolve, reject) => {
      const request = db.transaction("workspace").objectStore("workspace").get("site-frame2");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function writeState(value) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").put(value, "site-frame2");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("保存が中断されました"));
    });
  }

  async function saveDraft() {
    if (role === "viewer") return;
    if (busy) return;
    commitInlineEditors();
    if (!db) return toast("ブラウザ保存を利用できません。編集データを書き出してください。");
    busy = true;
    status();
    const savedRevision = revision;
    const snapshot = clone(state);
    snapshot.savedAt = new Date().toISOString();
    try {
      await writeState(snapshot);
      state.savedAt = snapshot.savedAt;
      if (revision === savedRevision) {
        dirty = false;
        toast("下書きをこのブラウザに保存しました。");
      } else {
        toast("保存処理中に追加の変更がありました。残りの変更をもう1度保存してください。");
      }
    } catch (error) {
      console.error("下書き保存に失敗しました", error);
      toast("保存できませんでした。保存容量を確認し、編集データを書き出してください。");
    } finally { busy = false; status(); }
  }

  function setText(node, text, ownText = false) {
    if (ownText) {
      [...node.childNodes].filter((part) => part.nodeType === 3).forEach((part) => part.remove());
      node.prepend(node.ownerDocument.createTextNode(text));
      return;
    }
    node.replaceChildren();
    text.split("\n").forEach((line, index) => {
      if (index) node.append(node.ownerDocument.createElement("br"));
      node.append(node.ownerDocument.createTextNode(line));
    });
  }

  function applyFields(doc, content) {
    fields.forEach((field) => {
      const node = doc.querySelector(`[data-cms-key="${field.key}"]`);
      if (!node) return;
      if (field.type === "image") {
        const image = content.images[field.key] || initial.images[field.key];
        setImage(node, image);
      } else if (content.values[field.key] !== field.value) {
        setText(node, content.values[field.key] ?? field.value, field.ownText);
      }
    });
    buttons.forEach((item) => {
      const node = doc.querySelector(`[data-cms-button="${item.key}"]`);
      if (node) applyLink(node, content.links?.[item.key] || initial.links[item.key]);
    });
    renderRecruitButtons(doc, content);
    renderFAQDocument(doc, content);
    const recruit = content.pages.find(p => p.id === "recruit");
    contentModel.head(doc, content.settings, {title:recruit?.seoTitle || content.settings.title,description:recruit?.seoDescription || content.settings.description});
  }

  function applyLink(node, link) {
    let url = "";
    try { url = model.safeUrl(link?.url, siteBase); } catch { /* 保存済みの危険なリンクも無効にする。 */ }
    const wasButton = node.tagName === "BUTTON" || node.dataset.cmsOriginalTag === "button";
    if (wasButton && ((url && node.tagName === "BUTTON") || (!url && node.tagName === "A"))) {
      const replacement = node.ownerDocument.createElement(url ? "a" : "button");
      [...node.attributes].forEach((attribute) => { if (attribute.name !== "type") replacement.setAttribute(attribute.name, attribute.value); });
      replacement.dataset.cmsOriginalTag = "button";
      if (!url) replacement.type = "button";
      while (node.firstChild) replacement.append(node.firstChild);
      node.replaceWith(replacement);
      node = replacement;
    }
    node.dataset.linkUrl = url;
    node.dataset.linkTarget = link?.target === "_blank" ? "_blank" : "_self";
    if (node.tagName === "A") {
      if (url) node.setAttribute("href", url);
      else node.removeAttribute("href");
      node.target = node.dataset.linkTarget;
      node.rel = "noopener noreferrer";
    } else {
      node.removeAttribute("href");
      node.removeAttribute("target");
      node.removeAttribute("rel");
    }
    return node;
  }

  function renderRecruitButtons(doc, content) {
    const nav = doc.querySelector(".recruit-nav");
    if (!nav) return;
    nav.replaceChildren();
    (content.recruitButtons || initial.recruitButtons).forEach((item) => {
      const node = doc.createElement("a");
      node.textContent = item.label;
      if (item.key) node.dataset.cmsKey = item.key;
      node.dataset.cmsButton = `recruit:${item.id}`;
      applyLink(node, item);
      nav.append(node);
    });
  }

  function setImage(node, image) {
    node.src = image.src;
    node.alt = image.alt;
    const width = Number(node.getAttribute("width"));
    const height = Number(node.getAttribute("height"));
    if (image.src.startsWith("data:") && width && height) {
      node.style.aspectRatio = `${width} / ${height}`;
      node.style.objectFit = "cover";
      node.style.height = "auto";
    } else {
      node.style.removeProperty("aspect-ratio");
      node.style.removeProperty("object-fit");
      node.style.removeProperty("height");
    }
  }

  function renderFAQDocument(doc, content) {
    const root = doc.querySelector("#faq");
    if (!root) return;
    [...root.children].filter((node) => node.tagName !== "H2").forEach((node) => node.remove());
    let previousCategory;
    content.faqs.forEach((faq) => {
      if (faq.category !== previousCategory) {
        const heading = doc.createElement("h3");
        heading.textContent = faq.category || "よくある質問";
        heading.dataset.faqCategory = faq.id;
        root.append(heading);
        previousCategory = faq.category;
      }
      const item = doc.createElement("details");
      item.open = true;
      item.dataset.faqId = faq.id;
      const question = doc.createElement("summary");
      question.textContent = faq.question;
      question.dataset.faqEdit = "question";
      const answer = doc.createElement("div");
      answer.className = "answer";
      answer.dataset.faqEdit = "answer";
      setText(answer, faq.answer);
      item.append(question, answer);
      root.append(item);
    });
  }

  function pageDocument(content) {
    if (!content.pages.some(p => p.id === "recruit" && (previewMode === "draft" || p.listed))) return "<!doctype html><html lang=ja><head><meta name=robots content=noindex,nofollow><title>採用ページ</title></head><body><p>採用ページはこの版では掲載されていません。固定ページ管理または反映履歴を確認してください。</p></body></html>";
    const doc = source.cloneNode(true);
    applyFields(doc, content);
    return "<!doctype html>" + doc.documentElement.outerHTML;
  }

  function renderPagePreview() {
    commitInlineEditors();
    pageScroll = $("#preview").contentWindow?.scrollY || 0;
    $("#preview").srcdoc = pageDocument(state[previewMode]);
  }

  function updatePreviewField(field) {
    if (previewMode !== "draft" || role === "viewer") return;
    const doc = $("#preview").contentDocument;
    const node = doc?.querySelector(`[data-cms-key="${field.key}"]`);
    if (!node) return;
    if (field.type === "image") {
      setImage(node, state.draft.images[field.key]);
    } else {
      const recruit = state.draft.recruitButtons.find((item) => item.key === field.key);
      if (recruit) recruit.label = state.draft.values[field.key];
      setText(node, state.draft.values[field.key], field.ownText);
    }
  }

  function selectGroup(id, key, scrollPreview = false) {
    selectedGroup = id;
    $("#section-select").value = id;
    renderFields();
    const doc = $("#preview").contentDocument;
    if (doc) {
      $$(".cms-selected", doc).forEach((node) => node.classList.remove("cms-selected"));
      const target = key ? doc.querySelector(`[data-cms-key="${key}"]`) : doc.querySelector(`[data-cms-group="${id}"]`);
      target?.classList.add("cms-selected");
      if (scrollPreview) target?.scrollIntoView({ block: "start" });
    }
  }

  function renderFields() {
    const root = $("#fields");
    if (!state.draft.pages.some(p => p.id === "recruit")) {root.replaceChildren();return;}
    root.replaceChildren();
    const group = groups.find((item) => item.id === selectedGroup);
    group.fields.forEach((field) => {
      const wrap = createElement("div", { className: "field" });
      const controlId = `input-${field.key}`;
      wrap.append(createElement("label", { for: controlId }, field.label));
      if (field.type === "text") {
        const control = createElement("textarea", { id: controlId, rows: field.value.length > 180 ? 8 : 3, maxlength: "16000", value: state.draft.values[field.key] });
        control.addEventListener("input", () => {
          state.draft.values[field.key] = control.value;
          markDirty();
          updatePreviewField(field);
        });
        wrap.append(control);
      } else {
        const image = state.draft.images[field.key];
        const preview = createElement("img", { className: "field-img", src: new URL(image.src, siteBase).href, alt: image.alt });
        const input = createElement("input", { type: "file", id: controlId, accept: "image/png,image/jpeg,image/webp" });
        input.addEventListener("change", async () => {
          const file = input.files[0];
          if (!file) return;
          try {
            const data = await readImage(file);
            state.draft.images[field.key].src = data;
            markDirty();
            updatePreviewField(field);
            preview.src = data;
            toast("画像を差し替えました。下書き保存で保持できます。");
          } catch (error) { toast(error.message); }
          input.value = "";
        });
        const options = createElement("div", { className: "image-options" });
        options.append(button("元画像に戻す", () => {
          state.draft.images[field.key] = clone(initial.images[field.key]);
          markDirty();
          updatePreviewField(field);
          renderFields();
        }));
        const alt = createElement("input", { value: image.alt, maxlength: "250", "aria-label": `${field.label}の代替テキスト` });
        alt.addEventListener("input", () => { state.draft.images[field.key].alt = alt.value; markDirty(); updatePreviewField(field); });
        wrap.append(preview, input, options, createElement("label", {}, "画像の説明（代替テキスト）"), alt, createElement("p", { className: "field-note" }, "PNG・JPEG・WebP、2MBまで。表示枠の縦横比は保たれます。"));
      }
      root.append(wrap);
    });
    if (selectedGroup === "faq") renderFAQFields(root);
    const readonly = previewMode === "published" || role === "viewer";
    $$("input,textarea,button", root).forEach((node) => { node.disabled = readonly; });
  }

  function readImage(file) {
    return new Promise((resolve, reject) => {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return reject(new Error("PNG・JPEG・WebP画像を選んでください。"));
      if (file.size > 2 * 1024 * 1024) return reject(new Error("画像は2MB以内にしてください。"));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("画像を読み込めませんでした。"));
      reader.onload = () => {
        const image = new Image();
        image.onload = () => resolve(reader.result);
        image.onerror = () => reject(new Error("画像として開けるファイルを選んでください。"));
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function inlineText(node) {
    const copy = node.cloneNode(true);
    $$("[data-cms-ui]", copy).forEach((item) => item.remove());
    $$("br", copy).forEach((br) => br.replaceWith("\n"));
    return copy.textContent.replace(/\r\n/g, "\n");
  }

  function syncInline(node) {
    if (!node?.isConnected || previewMode !== "draft" || role === "viewer") return;
    const value = inlineText(node);
    if (node.dataset.inlineField) {
      const key = node.dataset.inlineField;
      if (state.draft.values[key] === value) return;
      state.draft.values[key] = value;
      const control = document.getElementById(`input-${key}`);
      if (control) control.value = value;
    } else {
      const faq = state.draft.faqs.find((item) => item.id === node.dataset.inlineFaq);
      if (!faq) return;
      const key = node.dataset.inlinePart;
      if (faq[key] === value) return;
      if (key === "category") {
        const before = faq.category;
        state.draft.faqs.forEach((item) => { if (item.category === before) item.category = value; });
      } else faq[key] = value;
    }
    markDirty();
  }

  function commitInlineEditors() {
    if (role === "viewer") return;
    const editor = activeInline;
    if (!editor) return;
    // フォーカス移動でIMEの確定イベントを発生させ、入力DOMから値を確定する。
    editor.blur();
    syncInline(editor);
    activeInline = null;
  }

  function insertPlainText(node, value) {
    const selection = node.ownerDocument.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!node.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    const text = node.ownerDocument.createTextNode(value);
    range.insertNode(text);
    range.setStartAfter(text);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    syncInline(node);
  }

  function makeInline(node, attributes) {
    if (!node || node.hasAttribute("contenteditable")) return;
    node.setAttribute("contenteditable", "plaintext-only");
    node.setAttribute("spellcheck", "false");
    node.setAttribute("role", "textbox");
    node.setAttribute("aria-multiline", "true");
    Object.assign(node.dataset, attributes);
    node.addEventListener("focus", () => { activeInline = node; });
    node.addEventListener("input", () => syncInline(node));
    node.addEventListener("compositionstart", () => { node.dataset.composing = "true"; });
    node.addEventListener("compositionend", () => { delete node.dataset.composing; syncInline(node); });
    node.addEventListener("blur", () => { syncInline(node); if (activeInline === node) activeInline = null; });
    node.addEventListener("beforeinput", (event) => {
      if (event.isComposing) return;
      if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) {
        event.preventDefault(); insertPlainText(node, "\n");
      } else if (event.inputType.startsWith("format")) event.preventDefault();
    });
    node.addEventListener("paste", (event) => {
      event.preventDefault(); insertPlainText(node, event.clipboardData.getData("text/plain"));
    });
    node.addEventListener("drop", (event) => {
      event.preventDefault(); insertPlainText(node, event.dataTransfer.getData("text/plain"));
    });
  }

  function frameButton(doc, text, handler) {
    const node = doc.createElement("button");
    node.type = "button";
    node.textContent = text;
    node.addEventListener("click", handler);
    return node;
  }

  function prepareInlineElements(doc) {
    if (previewMode !== "draft" || role === "viewer") return;
    fields.filter((field) => field.type === "text").forEach((field) => {
      const node = doc.querySelector(`[data-cms-key="${field.key}"]`);
      if (!node || node.dataset.cmsButton) return;
      makeInline(node, { inlineField: field.key });
    });
    $$("[data-faq-edit]", doc).forEach((node) => {
      makeInline(node, { inlineFaq: node.closest("[data-faq-id]").dataset.faqId, inlinePart: node.dataset.faqEdit });
    });
    $$("[data-faq-category]", doc).forEach((node) => makeInline(node, { inlineFaq: node.dataset.faqCategory, inlinePart: "category" }));
    $$("[data-faq-id]", doc).forEach((item) => {
      if ($("[data-cms-ui]", item)) return;
      const tools = doc.createElement("div");
      tools.dataset.cmsUi = "faq";
      tools.className = "cms-inline-tools";
      const id = item.dataset.faqId;
      tools.append(
        frameButton(doc, "↑", () => moveFAQ(id, -1)),
        frameButton(doc, "↓", () => moveFAQ(id, 1)),
        frameButton(doc, "削除", () => deleteFAQ(id)),
      );
      item.append(tools);
    });
    const faqRoot = $("#faq", doc);
    if (faqRoot && !$("[data-cms-ui='faq-add']", faqRoot)) {
      const add = frameButton(doc, "＋ 質問を追加", addFAQ);
      add.dataset.cmsUi = "faq-add";
      add.className = "cms-inline-add";
      faqRoot.append(add);
    }
    const recruitNav = $(".recruit-nav", doc);
    if (recruitNav && !$("[data-cms-ui='recruit-add']", recruitNav)) {
      const add = frameButton(doc, "＋ ボタンを追加", addRecruitButton);
      add.dataset.cmsUi = "recruit-add";
      add.className = "cms-inline-add";
      recruitNav.append(add);
    }
    const hero = $(".hero", doc);
    const heroImage = hero && $("img[data-cms-key]", hero);
    if (heroImage && !$("[data-cms-ui='hero-image']", hero)) {
      const field = fields.find((item) => item.key === heroImage.dataset.cmsKey);
      const edit = frameButton(doc, "メイン画像を編集", () => openImagePanel(doc, heroImage, field));
      edit.dataset.cmsUi = "hero-image";
      edit.className = "cms-hero-image-tool";
      hero.append(edit);
    }
  }

  function attachInlineEditor(doc) {
    activeInline = null;
    if (previewMode === "draft" && role !== "viewer") {
      const style = doc.createElement("style");
      style.dataset.cmsUi = "style";
      style.textContent = `
        [contenteditable]{cursor:text;white-space:pre-wrap;overflow-wrap:anywhere;outline-offset:4px;min-height:1em}
        [contenteditable]:hover,[data-cms-key]:hover,[data-cms-button]:hover{outline:2px dashed #5c9568;outline-offset:3px}
        [contenteditable]:focus{outline:3px solid #458556;background:#f2f9ed80}
        [data-cms-key], [data-cms-button]{cursor:pointer}
        [contenteditable]{cursor:text}
        .cms-selected{outline:2px solid #458556;outline-offset:3px}
        .cms-inline-tools{display:flex;gap:8px;margin:10px 0 0;opacity:.65}
        .cms-inline-tools button,.cms-inline-add{font:13px/1.5 Meiryo,sans-serif;color:#315638;background:#f1f7e7;border:1px solid #9db396;border-radius:6px;padding:7px 12px;cursor:pointer}
        .cms-inline-add{margin:8px 0;min-height:42px}
        .hero-copy{pointer-events:none}.hero-copy span{pointer-events:auto}
        .cms-hero-image-tool{position:absolute;top:12px;right:12px;z-index:5;font:13px/1.5 Meiryo,sans-serif;padding:8px 12px;background:white;color:#315638;border:1px solid #8da983;border-radius:7px;box-shadow:0 2px 8px #18321c22;cursor:pointer}
        .cms-inline-panel{position:fixed;z-index:99999;width:330px;max-height:90vh;overflow:auto;background:white;color:#244131;border:1px solid #adc0a5;border-radius:12px;padding:18px;box-shadow:0 6px 35px #18321c44;font:14px/1.6 Meiryo,sans-serif}
        .cms-inline-panel *{box-sizing:border-box}
        .cms-inline-panel h3{font-size:18px!important;margin:0 0 12px!important;color:#244131!important}
        .cms-inline-panel label{display:block;font-weight:bold;font-size:12px;margin:12px 0 5px}
        .cms-inline-panel input,.cms-inline-panel textarea,.cms-inline-panel select{width:100%;padding:9px;border:1px solid #c6d3c2;border-radius:5px;font:14px/1.5 Meiryo,sans-serif;background:white;color:#244131}
        .cms-inline-panel textarea{min-height:75px;resize:vertical}
        .cms-inline-panel p{font-size:11px!important;line-height:1.6!important;margin:10px 0!important;color:#61715b}
        .cms-inline-panel button{font:13px/1.5 Meiryo,sans-serif;padding:7px 10px;border:1px solid #c6d3c2;border-radius:5px;background:#f1f7e7;color:#315638;cursor:pointer}
        .cms-panel-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
        .cms-panel-error{color:#b32c22!important;min-height:1.5em}
      `;
      doc.head.append(style);
      prepareInlineElements(doc);
    }
    doc.addEventListener("click", (event) => {
      if (event.target.closest("[data-cms-ui]")) return;
      const editable = event.target.closest("[contenteditable]");
      const image = event.target.closest("img[data-cms-key]");
      const buttonNode = event.target.closest("[data-cms-button]");
      if (event.target.closest("a,button,summary")) event.preventDefault();
      if (previewMode !== "draft" || role === "viewer") return;
      closeInlinePanel(doc);
      if (editable) {
        const field = fields.find((item) => item.key === editable.dataset.inlineField);
        selectGroup(field?.group || "faq");
        // summaryの既定操作を止めてもテキストにキャレットを置けるようにする。
        if (doc.activeElement !== editable) editable.focus({ preventScroll: true });
      } else if (image) {
        const field = fields.find((item) => item.key === image.dataset.cmsKey);
        selectGroup(field.group);
        openImagePanel(doc, image, field);
      } else if (buttonNode) {
        const item = buttonNode.dataset.cmsButton.startsWith("recruit:")
          ? state.draft.recruitButtons.find((entry) => `recruit:${entry.id}` === buttonNode.dataset.cmsButton)
          : buttons.find((entry) => entry.key === buttonNode.dataset.cmsButton);
        if (item) { selectGroup(item.group || "hero"); openButtonPanel(doc, buttonNode, item); }
      }
    });
    doc.defaultView.addEventListener("resize", () => {
      const panel = $(".cms-inline-panel", doc);
      if (panel) fitInlinePanel(panel);
    });
  }

  function closeInlinePanel(doc = $("#preview").contentDocument) {
    $(".cms-inline-panel", doc)?.remove();
  }

  function panelAt(doc, target, title) {
    commitInlineEditors();
    closeInlinePanel(doc);
    const panel = doc.createElement("aside");
    panel.dataset.cmsUi = "panel";
    panel.className = "cms-inline-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", title);
    const heading = doc.createElement("h3"); heading.textContent = title;
    panel.append(heading);
    doc.body.append(panel);
    const rect = target.getBoundingClientRect();
    const left = Math.min(Math.max(10, rect.left), Math.max(10, doc.documentElement.clientWidth - 340));
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(10, Math.min(rect.bottom + 8, doc.documentElement.clientHeight - 360))}px`;
    panel.addEventListener("keydown", (event) => { if (event.key === "Escape") closeInlinePanel(doc); });
    return panel;
  }

  function fitInlinePanel(panel) {
    const doc = panel.ownerDocument;
    const height = doc.documentElement.clientHeight;
    const width = doc.documentElement.clientWidth;
    panel.style.maxHeight = `${Math.max(100, height - 24)}px`;
    panel.style.width = `${Math.min(330, Math.max(150, width - 24))}px`;
    const rect = panel.getBoundingClientRect();
    const top = Number.parseFloat(panel.style.top) || 12;
    const left = Number.parseFloat(panel.style.left) || 12;
    panel.style.top = `${Math.max(12, Math.min(top, height - rect.height - 12))}px`;
    panel.style.left = `${Math.max(12, Math.min(left, width - rect.width - 12))}px`;
  }

  function panelInput(doc, panel, label, value, handler, tag = "input") {
    const wrap = doc.createElement("label");
    wrap.textContent = label;
    const input = doc.createElement(tag);
    input.value = value;
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => handler(input.value));
    panel.append(wrap, input);
    return input;
  }

  function panelLinks(doc, panel, link, onChange) {
    const error = doc.createElement("p"); error.className = "cms-panel-error";
    const input = panelInput(doc, panel, "リンク先（空欄でリンクなし）", link.url || "", (value) => {
      try {
        const url = model.safeUrl(value, siteBase);
        error.textContent = ""; input.removeAttribute("aria-invalid");
        link.url = url; onChange();
      } catch (failure) {
        error.textContent = `${failure.message} この入力は保存されません。`;
        input.setAttribute("aria-invalid", "true");
      }
      fitInlinePanel(panel);
    });
    input.placeholder = "#requirements / https://... / tel:...";
    panel.append(error);
    const target = panelInput(doc, panel, "開き方", "", () => {}, "select");
    [["_self", "同じタブ"], ["_blank", "新しいタブ"]].forEach(([value, text]) => {
      const option = doc.createElement("option"); option.value = value; option.textContent = text; target.append(option);
    });
    target.value = link.target || "_self";
    target.addEventListener("change", () => { link.target = target.value; onChange(); });
  }

  function openImagePanel(doc, node, field) {
    const panel = panelAt(doc, node, "画像を編集");
    const note = doc.createElement("p"); note.textContent = "PNG・JPEG・WebP、2MBまで。元の表示枠に合わせます。";
    panel.append(note);
    const input = doc.createElement("input");
    input.type = "file"; input.accept = "image/png,image/jpeg,image/webp";
    input.setAttribute("aria-label", "差し替える画像");
    input.addEventListener("change", async () => {
      const file = input.files[0]; if (!file) return;
      try {
        const data = await readImage(file);
        state.draft.images[field.key].src = data;
        markDirty(); updatePreviewField(field); renderFields();
        toast("画像を差し替えました。");
      } catch (error) { toast(error.message); }
      input.value = "";
    });
    panel.append(input);
    panelInput(doc, panel, "画像の説明（代替テキスト）", state.draft.images[field.key].alt, (value) => {
      state.draft.images[field.key].alt = value;
      markDirty(); updatePreviewField(field);
    });
    let buttonNode = node.closest("[data-cms-button]");
    if (buttonNode) panelLinks(doc, panel, state.draft.links[buttonNode.dataset.cmsButton], () => {
      buttonNode = applyLink(buttonNode, state.draft.links[buttonNode.dataset.cmsButton]); markDirty();
    });
    const controls = doc.createElement("div"); controls.className = "cms-panel-actions";
    controls.append(
      frameButton(doc, "元画像に戻す", () => {
        state.draft.images[field.key] = clone(initial.images[field.key]);
        markDirty(); updatePreviewField(field); renderFields();
        openImagePanel(doc, node, field);
      }),
      frameButton(doc, "閉じる", () => closeInlinePanel(doc)),
    );
    panel.append(controls);
    fitInlinePanel(panel);
  }

  function openButtonPanel(doc, node, item) {
    const dynamic = !!item.id;
    const panel = panelAt(doc, node, "ボタンを編集");
    const field = dynamic ? fields.find((entry) => entry.key === item.key) : item.field;
    if (dynamic || field) panelInput(doc, panel, "表示名", dynamic ? item.label : state.draft.values[field.key], (value) => {
      if (dynamic) item.label = value;
      if (field) state.draft.values[field.key] = value;
      setText(node, value, field?.ownText);
      markDirty();
      const control = field && document.getElementById(`input-${field.key}`);
      if (control) control.value = value;
    });
    const link = dynamic ? item : state.draft.links[item.key];
    panelLinks(doc, panel, link, () => { node = applyLink(node, link); markDirty(); });
    const note = doc.createElement("p"); note.textContent = "プレビュー内ではリンクを実行しません。変更は下書きへ記録されます。";
    panel.append(note);
    const controls = doc.createElement("div"); controls.className = "cms-panel-actions";
    if (dynamic) {
      const index = state.draft.recruitButtons.findIndex((entry) => entry.id === item.id);
      const up = frameButton(doc, "← 前へ", () => moveRecruitButton(item.id, -1)); up.disabled = index === 0;
      const down = frameButton(doc, "次へ →", () => moveRecruitButton(item.id, 1)); down.disabled = index === state.draft.recruitButtons.length - 1;
      controls.append(up, down, frameButton(doc, "削除", () => deleteRecruitButton(item.id)), frameButton(doc, "＋ 追加", addRecruitButton));
    }
    controls.append(frameButton(doc, "閉じる", () => closeInlinePanel(doc)));
    panel.append(controls);
    fitInlinePanel(panel);
  }

  function refreshRecruitButtons() {
    commitInlineEditors();
    const doc = $("#preview").contentDocument;
    closeInlinePanel(doc);
    renderRecruitButtons(doc, state.draft);
    prepareInlineElements(doc);
    renderFields();
  }

  function addRecruitButton() {
    commitInlineEditors();
    const item = { id: crypto.randomUUID(), label: "新しいボタン", url: "", target: "_self" };
    state.draft.recruitButtons.push(item);
    markDirty(); refreshRecruitButtons();
    const doc = $("#preview").contentDocument;
    const node = doc.querySelector(`[data-cms-button="recruit:${item.id}"]`);
    node.scrollIntoView({ block: "nearest" }); openButtonPanel(doc, node, item);
  }

  function moveRecruitButton(id, direction) {
    commitInlineEditors();
    const list = state.draft.recruitButtons;
    const index = list.findIndex((item) => item.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    markDirty(); refreshRecruitButtons();
    const doc = $("#preview").contentDocument;
    openButtonPanel(doc, doc.querySelector(`[data-cms-button="recruit:${id}"]`), list[next]);
  }

  async function deleteRecruitButton(id) {
    commitInlineEditors();
    if (!await confirmAction("このボタンを下書きから削除しますか？反映済みページは次の反映まで保持されます。", "ボタンを削除")) return;
    state.draft.recruitButtons = state.draft.recruitButtons.filter((item) => item.id !== id);
    markDirty(); refreshRecruitButtons();
  }

  function addFAQ() {
    commitInlineEditors();
    const item = { id: crypto.randomUUID(), category: state.draft.faqs.at(-1)?.category || "よくある質問", question: "新しい質問", answer: "回答を入力してください。" };
    state.draft.faqs.push(item); markDirty(); syncFAQ(); renderFields();
    const node = $("#preview").contentDocument.querySelector(`[data-faq-id="${item.id}"]`);
    node.scrollIntoView({ block: "nearest" });
    $("summary", node).focus({ preventScroll: true });
  }

  function moveFAQ(id, direction) {
    commitInlineEditors();
    const list = state.draft.faqs;
    const index = list.findIndex((item) => item.id === id);
    const next = index + direction;
    if (next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    markDirty(); syncFAQ(); renderFields();
  }

  async function deleteFAQ(id) {
    commitInlineEditors();
    if (!await confirmAction("この質問を下書きから削除しますか？反映済みページは次の反映まで保持されます。", "質問を削除")) return;
    state.draft.faqs = state.draft.faqs.filter((item) => item.id !== id);
    markDirty(); syncFAQ(); renderFields();
  }

  function syncFAQ() {
    if (previewMode === "draft") {
      commitInlineEditors();
      renderFAQDocument($("#preview").contentDocument, state.draft);
      prepareInlineElements($("#preview").contentDocument);
    }
  }

  function renderFAQFields(root) {
    root.append(createElement("p", { className: "faq-intro" }, `${state.draft.faqs.length}件の質問。カテゴリは自由に変更できます。`));
    state.draft.faqs.forEach((faq, index) => {
      const card = createElement("div", { className: "faq-card", id: `form-${faq.id}` });
      card.append(createElement("label", { className: "input-label" }, `質問 ${index + 1}`));
      [["category", "カテゴリ"], ["question", "質問"], ["answer", "回答"]].forEach(([key, label]) => {
        const control = createElement(key === "answer" ? "textarea" : "input", { value: faq[key], "aria-label": `${index + 1}件目の${label}`, maxlength: key === "answer" ? "16000" : "500" });
        control.addEventListener("input", () => { faq[key] = control.value; markDirty(); syncFAQ(); });
        card.append(control);
      });
      const controls = createElement("div", { className: "faq-tools" });
      const move = (direction) => {
        const destination = index + direction;
        if (destination < 0 || destination >= state.draft.faqs.length) return;
        [state.draft.faqs[index], state.draft.faqs[destination]] = [state.draft.faqs[destination], state.draft.faqs[index]];
        markDirty(); syncFAQ(); renderFields();
        document.getElementById(`form-${faq.id}`)?.scrollIntoView({ block: "nearest" });
      };
      const up = button("↑", () => move(-1));
      up.disabled = index === 0;
      up.setAttribute("aria-label", `質問${index + 1}を上へ`);
      const down = button("↓", () => move(1));
      down.disabled = index === state.draft.faqs.length - 1;
      down.setAttribute("aria-label", `質問${index + 1}を下へ`);
      controls.append(up, down, button("削除", async () => {
        if (!await confirmAction("この質問を下書きから削除しますか？反映済みの内容は次の反映まで残ります。", "下書きから削除")) return;
        state.draft.faqs.splice(index, 1);
        markDirty(); syncFAQ(); renderFields();
      }));
      card.append(controls);
      root.append(card);
    });
    root.append(button("＋ 質問を追加", () => {
      const faq = { id: crypto.randomUUID(), category: state.draft.faqs.at(-1)?.category || "よくある質問", question: "新しい質問", answer: "回答を入力してください。" };
      state.draft.faqs.push(faq);
      markDirty(); syncFAQ(); renderFields();
      document.getElementById(`form-${faq.id}`).scrollIntoView({ block: "nearest" });
    }, "btn small add-faq"));
  }

  function fitFrame(iframe, canvas) {
    if (!canvas || canvas.clientWidth < 1) return;
    const width = device === "mobile" ? 375 : 1080;
    const availableWidth = Math.max(100, canvas.clientWidth - 40);
    const availableHeight = Math.max(180, canvas.clientHeight - 40);
    const scale = Math.min(1, availableWidth / width);
    iframe.style.width = `${width}px`;
    iframe.style.height = `${availableHeight / scale}px`;
    iframe.style.transform = `scale(${scale})`;
    iframe.parentElement.style.width = `${width * scale}px`;
    iframe.parentElement.style.height = `${availableHeight}px`;
  }

  function fitPreviews() {
    fitFrame($("#preview"), $("#canvas"));
    const article = $("#article-preview-frame");
    if (article) fitFrame(article, $("#article-canvas"));
  }

  function changesSummary() {
    const draft = state.draft;
    const published = state.published;
    const textCount = fields.filter((field) => field.type === "text" && draft.values[field.key] !== published.values[field.key]).length;
    const imageCount = fields.filter((field) => field.type === "image" && JSON.stringify(draft.images[field.key]) !== JSON.stringify(published.images[field.key])).length;
    const faqChanged = JSON.stringify(draft.faqs) !== JSON.stringify(published.faqs);
      const articleChanged = draft.articles.filter((article) => JSON.stringify(article) !== JSON.stringify(published.articles.find((item) => item.id === article.id))).length;
    const removedArticles = published.articles.filter((article) => !draft.articles.some((item) => item.id === article.id)).length;
    const buttonsChanged = JSON.stringify(draft.recruitButtons) !== JSON.stringify(published.recruitButtons);
    const settingsChanged = JSON.stringify(draft.settings) !== JSON.stringify(published.settings);
    const linksChanged = Object.keys(draft.links).filter((key) => JSON.stringify(draft.links[key]) !== JSON.stringify(published.links[key])).length;
    return { textCount, imageCount, faqChanged, articleChanged, removedArticles, buttonsChanged, linksChanged, settingsChanged, pagesChanged: JSON.stringify(draft.pages) !== JSON.stringify(published.pages) };
  }

  function openPublish() {
    if (role !== "admin") return toast("デモ反映は管理者のみ操作できます。");
    commitInlineEditors();
    const changes = changesSummary();
    const root = $("#changes");
    root.replaceChildren();
    root.append(createElement("p", {}, `文章 ${changes.textCount}項目 / 画像・説明 ${changes.imageCount}項目`));
    root.append(createElement("p", {}, `リンク設定 ${changes.linksChanged}項目 / 採用ボタン群 ${changes.buttonsChanged ? "変更あり" : "変更なし"}`));
    root.append(createElement("p", {}, changes.faqChanged ? `FAQを更新（${state.draft.faqs.length}件）` : "FAQの変更なし"));
    root.append(createElement("p", {}, `記事の追加・更新 ${changes.articleChanged}件 / 削除 ${changes.removedArticles}件`));
    root.append(createElement("p", {}, `掲載設定の記事 ${state.draft.articles.filter((article) => article.listed).length}件を読者向け一覧に表示します。`));
    root.append(createElement("p", {}, `サイト共通・SEO設定：${changes.settingsChanged ? "変更あり" : "変更なし"}`));
    root.append(createElement("p", {}, `固定ページ：${changes.pagesChanged ? "変更あり" : "変更なし"} / 掲載 ${state.draft.pages.filter(p => p.listed).length}件`));
    $("#publish-dialog").showModal();
  }

  async function publish() {
    if (role !== "admin") return toast("デモ反映は管理者のみ操作できます。");
    if (busy) return;
    commitInlineEditors();
    if (!db) return toast("ブラウザ保存を利用できないため反映できません。");
    const listedPages = state.draft.pages.filter(p => p.listed);
    if (listedPages.some(p => !p.title.trim() || !p.slug.trim()) || new Set(listedPages.map(p => p.slug)).size !== listedPages.length) return toast("掲載する固定ページのタイトル・URL名と重複を確認してください。");
    const listed = state.draft.articles.filter((article) => article.listed);
    const invalid = listed.find((article) => !article.title.trim() || !article.body.trim() || !article.slug.trim());
    if (invalid) { toast("掲載する記事のタイトル・URL名・本文を入力してください。"); return; }
    if (new Set(listed.map((article) => article.slug)).size !== listed.length) { toast("掲載する記事のURL名が重複しています。"); return; }
    if (contentModel.duplicateSlugs([...listedPages, ...listed])) return toast("固定ページと記事を含め、掲載するURL名が重複しています。");
    busy = true; status();
    $("#confirm-publish").disabled = true;
    const savedRevision = revision;
    const snapshot = clone(state);
    const changes = changesSummary();
    const now = new Date().toISOString();
    snapshot.published = clone(snapshot.draft);
    snapshot.savedAt = now;
    snapshot.publishedAt = now;
    snapshot.history.unshift({ id: crypto.randomUUID(), date: now, changes, content: clone(snapshot.published) });
    snapshot.history = snapshot.history.slice(0, 10);
    try {
      await writeState(snapshot);
      // 保存中の入力は現在の下書きに残す。
      state.published = snapshot.published;
      state.history = snapshot.history;
      state.savedAt = now;
      state.publishedAt = now;
      if (revision === savedRevision) dirty = false;
      $("#publish-dialog").close();
      if (previewMode === "published") renderPagePreview();
      renderArticleItems(); renderArticlePreview(); renderHistory(); renderSettings(); renderFixedPages();
      toast(revision === savedRevision
        ? "このブラウザのデモ表示に反映しました。"
        : "デモ表示に反映しました。処理中に追加した変更は下書きに残っています。");
    } catch (error) {
      console.error("デモ反映に失敗しました", error);
      toast("反映できませんでした。反映済み表示を維持しています。");
    } finally { busy = false; $("#confirm-publish").disabled = false; status(); }
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  }

  function renderHistory() {
    const root = $("#history-items");
    root.replaceChildren();
    if (!state.history.length) {
      root.append(createElement("p", { className: "empty-state" }, "まだ反映履歴はありません。下書きをデモに反映すると記録されます。"));
      return;
    }
    state.history.forEach((entry, index) => {
      const card = createElement("div", { className: "history-card" });
      const info = createElement("div");
      info.append(createElement("h3", {}, new Date(entry.date).toLocaleString("ja-JP")));
      info.append(createElement("small", {}, `文章 ${entry.changes.textCount}項目・画像 ${entry.changes.imageCount}項目・記事 ${entry.content.articles.length}件 ${index === 0 ? " / 最新の反映" : ""}`));
      card.append(info, button("下書きへ復元", async () => {
        if (busy) return;
        if (!await confirmAction("この時点の内容を下書きへ復元しますか？現在の下書きは置き換わります。反映済み表示は変わりません。", "下書きへ復元")) return;
        commitInlineEditors();
        state.draft = model.completeContent(entry.content, initial);
        activeInline = null;
        selectedArticle = state.draft.articles[0]?.id || null;
        markDirty(); renderFields(); renderPagePreview(); renderArticles(); renderSettings(); renderFixedPages();
        await saveDraft();
      }));
      root.append(card);
    });
  }

  function newArticle(sample = false) {
    if (role === "viewer") return;
    const article = {
      id: crypto.randomUUID(), title: sample ? "院内見学の前に確認したいこと" : "", slug: `article-${Date.now()}`,
      summary: sample ? "見学前に整理しておくと役立つ質問を紹介します。" : "",
      body: sample ? "院内見学では、職場の雰囲気やスタッフの動きを実際に確認できます。\n\n## 先に質問を整理する\n\n研修の進め方、勤務時間、配属先など、知りたいことをメモしておきましょう。\n\n## 現場の様子を見る\n\n患者さんへの説明やスタッフ同士のやり取りを見て、自分に合う職場か考えてみましょう。\n\n※操作確認のための固定サンプルです。掲載前に内容を確認してください。" : "",
      category: "", tags: [], seoTitle: "", seoDescription: "",
      author: "採用担当", date: new Date().toLocaleDateString("sv-SE"), listed: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sample,
    };
    state.draft.articles.unshift(article);
    selectedArticle = article.id;
    articleRoute = "detail";
    articleMode = "draft";
    markDirty(); renderArticles();
  }

  function renderArticleItems() {
    const root = $("#article-items");
    root.replaceChildren();
    if (!state.draft.articles.length) root.append(createElement("p", { className: "muted" }, "新規作成して、タイトルと本文を入力してください。"));
    contentModel.union(state.draft.articles, state.published.articles).forEach((article) => {
      const item = button("", () => { selectedArticle = article.id; articleRoute = "detail"; renderArticles(); }, `article-item${selectedArticle === article.id ? " active" : ""}`);
      item.append(createElement("strong", {}, article.title || "タイトル未入力"));
      const live = state.published.articles.find((entry) => entry.id === article.id);
      const label = !state.draft.articles.some(item => item.id === article.id) ? "次の反映で削除" : !live ? "未反映" : JSON.stringify(live) !== JSON.stringify(article) ? "変更あり" : "反映済み";
      item.append(createElement("small", {}, `${article.listed ? "掲載する" : "下書き"} · ${label}`));
      item.append(createElement("small", {}, `${article.category || "未分類"} / ${(article.tags || []).join("・") || "タグなし"}`));
      root.append(item);
    });
    renderTaxonomy();
  }

  function renderArticles() {
    renderArticleItems();
    const root = $("#article-editor");
    root.replaceChildren();
    const draftArticle = state.draft.articles.find((item) => item.id === selectedArticle);
    const article = draftArticle || clone(state.published.articles.find(item => item.id === selectedArticle) || null);
    if (article && !draftArticle) articleMode = "published";
    if (!article) {
      const empty = createElement("div", { className: "article-form empty-state" });
      empty.append(createElement("h2", {}, "最初の記事をつくる"), createElement("p", {}, "自分で書き始めるか、操作確認用の固定サンプルを追加できます。"));
      const row = createElement("div", { className: "empty-actions" });
      row.append(button("＋ 記事を新規作成", () => newArticle()), button("固定サンプルを追加", () => newArticle(true)));
      empty.append(row);
      root.append(empty);
      return;
    }
    const form = createElement("div", { className: "article-form" });
    form.append(createElement("span", { className: "eyebrow" }, "ARTICLE EDITOR"), createElement("h2", {}, "記事を編集"));
    if (article.sample) form.append(createElement("p", { className: "sample-note" }, "操作確認用の固定サンプルです。AIで生成した文章ではありません。"));
    [["title", "タイトル", "input"], ["slug", "URL名（半角英数字・ハイフン）", "input"], ["summary", "概要", "textarea"], ["body", "本文（行頭の ## は見出しになります）", "textarea"], ["author", "著者", "input"], ["date", "記事の日付", "input"], ["category", "カテゴリー", "input"], ["tags", "タグ（カンマ区切りで複数指定）", "input"], ["seoTitle", "検索表示用タイトル（空欄なら記事タイトル）", "input"], ["seoDescription", "検索表示用説明（空欄なら概要）", "textarea"]].forEach(([key, label, tag]) => {
      const id = `article-${key}`;
      const control = createElement(tag, { id, value: key === "tags" ? (article.tags || []).join(", ") : article[key], className: key === "summary" ? "summary-input" : "", maxlength: key === "body" ? "60000" : "1000" });
      if (key === "date") control.type = "date";
      control.addEventListener("input", () => {
        article[key] = key === "slug" ? control.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() : key === "tags" ? contentModel.tags(control.value) : key === "category" ? control.value.trim() : control.value;
        if (key === "slug") control.value = article[key];
        article.updatedAt = new Date().toISOString();
        markDirty(); renderArticleItems(); renderArticlePreview();
      });
      form.append(createElement("label", { for: id, className: "input-label" }, label), control);
    });
    const suggestions = createElement("div", {className:"tag-suggestions"});
    suggestions.append(createElement("p", {className:"muted"}, "本文に2回以上出てくる語からタグ候補を作ります。候補を選ぶと既存のタグに追加されます。"));
    const candidates = createElement("div", {"aria-live":"polite"});
    suggestions.append(button("本文からタグ候補を抽出", () => {
      if (role === "viewer") return;
      candidates.replaceChildren();
      const found = contentModel.suggestTags(article.body, article.tags);
      if (!found.length) candidates.append(createElement("p", {}, "追加できる頻出語はありません。タグは手入力もできます。"));
      found.forEach(({tag,count}) => candidates.append(button(tag + "（" + count + "回）を追加", event => {
        if(role === "viewer")return;
        article.tags = contentModel.tags([...article.tags,tag]); article.updatedAt = new Date().toISOString();
        $("#article-tags").value = article.tags.join(", "); event.currentTarget.disabled=true;event.currentTarget.textContent=tag + " 追加済み";
        markDirty();renderArticleItems();renderArticlePreview();
      })));
    }),candidates);form.append(suggestions);
    const listing = createElement("label", { className: "listing-option" });
    const checkbox = createElement("input", { type: "checkbox", checked: article.listed });
    checkbox.addEventListener("change", () => { article.listed = checkbox.checked; article.updatedAt = new Date().toISOString(); markDirty(); renderArticleItems(); renderArticlePreview(); });
    listing.append(checkbox, document.createTextNode("次のデモ反映で記事一覧に掲載する"));
    form.append(listing, createElement("p", { className: "muted" }, "チェックを外した記事は下書きとして保存され、反映済みの記事一覧には表示されません。"));
    const controls = createElement("div", { className: "article-actions" });
    controls.append(button("下書き保存", saveDraft), button("デモに反映", openPublish, "btn small primary"), button("削除", async () => {
      if (!await confirmAction("この記事を下書きから削除しますか？反映済みの記事は次の反映まで残ります。", "下書きから削除")) return;
      state.draft.articles = state.draft.articles.filter((item) => item.id !== article.id);
      markDirty(); renderArticles();
    }));
    $$("button", controls).forEach((item) => { item.disabled = busy; });
    form.append(controls);
    const preview = createElement("div", { className: "article-reader" });
    const toolbar = createElement("div", { className: "article-reader-toolbar" });
    toolbar.append(createElement("strong", {}, "読者向けプレビュー"));
    const mode = createElement("select", { "aria-label": "記事プレビューの版" });
    [["draft", "編集中"], ["published", "反映済み"]].forEach(([value, label]) => mode.append(createElement("option", { value }, label)));
    mode.value = articleMode;
    mode.addEventListener("change", () => { articleMode = mode.value; renderArticlePreview(); });
    const route = createElement("select", { "aria-label": "記事プレビューの表示" });
    [["detail", "記事詳細"], ["list", "記事一覧"], ["taxonomy", "カテゴリー・タグ別一覧"]].forEach(([value, label]) => route.append(createElement("option", { value }, label)));
    route.value = articleRoute;
    route.addEventListener("change", () => { articleRoute = route.value; renderArticlePreview(); });
    toolbar.append(mode, route, button(device === "mobile" ? "PCで見る" : "スマホで見る", () => {
      device = device === "mobile" ? "desktop" : "mobile";
      setDevice(device);
      renderArticles();
    }));
    const canvas = createElement("div", { id: "article-canvas", className: "preview-scroll" });
    const holder = createElement("div", { className: "frame-holder" });
    const iframe = createElement("iframe", { id: "article-preview-frame", title: "読者向け記事プレビュー", sandbox: "allow-same-origin" });
    iframe.addEventListener("load", () => {
      iframe.contentWindow.scrollTo(0, Number(iframe.dataset.scroll || 0));
      const doc = iframe.contentDocument;
      doc.addEventListener("click", (event) => {
        const link = event.target.closest("a,button");
        if (!link) return;
        event.preventDefault();
        if (link.dataset.articleId) { selectedArticle = link.dataset.articleId; articleRoute = "detail"; renderArticles(); }
        else if (link.dataset.taxonomyKind) { taxonomyKind = link.dataset.taxonomyKind; taxonomyName = link.dataset.taxonomyName; articleRoute = "taxonomy"; renderArticles(); }
        else if (link.dataset.articleList !== undefined) { articleRoute = "list"; renderArticles(); }
        else toast("記事プレビューでは記事一覧・詳細の移動を確認できます。");
      });
    });
    holder.append(iframe); canvas.append(holder); preview.append(toolbar, canvas);
    if (!draftArticle) form.replaceChildren(createElement("h2", {}, "下書きから削除した記事"), createElement("p", {}, "反映済みの内容を確認できます。次のデモ反映で掲載が終了します。"));
    root.append(form, preview);
    renderArticlePreview();
    updateRoleControls();
    requestAnimationFrame(fitPreviews);
  }

  function renderArticlePreview() {
    const iframe = $("#article-preview-frame");
    if (!iframe) return;
    const routeKey = `${articleMode}:${articleRoute}:${selectedArticle}:${taxonomyKind}:${taxonomyName}`;
    iframe.dataset.scroll = iframe.dataset.route === routeKey ? iframe.contentWindow?.scrollY || 0 : 0;
    iframe.dataset.route = routeKey;
    const content = state[articleMode];
    const doc = source.cloneNode(true);
    applyFields(doc, content);
    $(".leaf-bg", doc)?.remove();
    const main = $("main", doc);
    main.replaceChildren();
    const extra = doc.createElement("style");
    extra.textContent = `.reader{padding:55px 55px 80px;max-width:930px;margin:auto}.reader h1{font-size:32px;line-height:1.5;border-left:8px solid #ecdd6e;padding-left:20px;overflow-wrap:anywhere}.reader .meta{font-size:13px;color:#777;margin:20px 0}.reader .lead{background:#f3f8ed;padding:22px;line-height:1.9}.reader p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:2;margin:24px 0}.reader h2{font-size:24px;margin-top:40px}.reader a{color:#268342}.reader-card{border-bottom:1px solid #ddd;padding:25px 0}.reader-card h2{margin:0 0 12px}.reader footer{margin-top:40px}@media(max-width:700px){.reader{padding:30px 22px 60px}.reader h1{font-size:25px}.reader h2{font-size:21px}.reader .lead{padding:16px}}`;
    doc.head.append(extra);
    const article = content.articles.find((item) => item.id === selectedArticle);
    const root = doc.createElement("article");
    root.className = "reader";
    const append = (tag, text, parent = root) => {
      const node = doc.createElement(tag); node.textContent = text; parent.append(node); return node;
    };
    const taxonomyLinks = (item, parent) => {
      const values = [["category", item.category || "未分類"], ...(item.tags || []).map(tag => ["tag", tag])];
      values.forEach(([kind, name]) => { const a = append("a", (kind === "tag" ? "#" : "") + name, parent); a.href = "#" + kind + "-" + encodeURIComponent(name); a.dataset.taxonomyKind = kind; a.dataset.taxonomyName = name; a.style.marginRight = "14px"; });
    };
    if (articleRoute !== "detail") {
      append("h1", articleRoute === "taxonomy" && taxonomyKind ? taxonomyName + "の記事" : "採用コラム・お知らせ");
      const nav = append("nav", ""); nav.setAttribute("aria-label", "記事の分類");
      ["category", "tag"].forEach(kind => contentModel.taxonomy(content.articles.filter(a => a.listed), kind).forEach((items, name) => { const a = append("a", (kind === "tag" ? "#" : "") + name + " (" + items.length + ")", nav); a.href = "#" + kind + "-" + encodeURIComponent(name); a.dataset.taxonomyKind = kind; a.dataset.taxonomyName = name; a.style.marginRight = "14px"; }));
      const listed = contentModel.filter(content.articles, articleRoute === "taxonomy" ? taxonomyKind : "", taxonomyName);
      if (!listed.length) append("p", "掲載する記事はまだありません。");
      listed.forEach((item) => {
        const card = doc.createElement("div"); card.className = "reader-card";
        const link = append("a", item.title || "タイトル未入力", append("h2", "", card));
        link.href = `#${item.slug}`; link.dataset.articleId = item.id;
        append("small", `${item.date} / ${item.author}`, card);
        append("p", item.summary, card);
        taxonomyLinks(item, card);
        root.append(card);
      });
    } else if (article && (articleMode === "draft" || article.listed)) {
      append("h1", article.title || "タイトル未入力");
      taxonomyLinks(article, append("nav", ""));
      const meta = append("p", `${article.date} / ${article.author}`); meta.className = "meta";
      const lead = append("p", article.summary); lead.className = "lead";
      let paragraph = [];
      const flushParagraph = () => {
        if (paragraph.length) append("p", paragraph.join("\n"));
        paragraph = [];
      };
      article.body.split("\n").forEach((line) => {
        if (line.startsWith("## ")) {
          flushParagraph();
          append("h2", line.slice(3));
        } else if (!line.trim()) flushParagraph();
        else paragraph.push(line);
      });
      flushParagraph();
    } else {
      append("h1", "この記事は反映済み表示に掲載されていません");
      append("p", "記事を掲載する設定にし、デモに反映すると読者向け表示を確認できます。");
    }
    const back = append("a", "記事一覧へ"); back.href = "#articles"; back.dataset.articleList = "";
    main.append(root);
    const shown = article && (articleMode === "draft" || article.listed);
    contentModel.head(doc, content.settings, articleRoute === "detail" ? { title: shown ? article.seoTitle || article.title : "未掲載の記事", description: shown ? article.seoDescription || article.summary : "", type: "article" } : { title: articleRoute === "taxonomy" && taxonomyKind ? taxonomyName + "の記事" : "採用コラム・お知らせ", description: "" });
    iframe.srcdoc = "<!doctype html>" + doc.documentElement.outerHTML;
  }


  function renderTaxonomy() {
    const root = $("#taxonomy-items"); root.replaceChildren();
    const mode = $("#taxonomy-mode").value;
    const articles = state[mode].articles.filter(a => mode === "draft" || a.listed);
    ["category", "tag"].forEach(kind => {
      root.append(createElement("h3", {}, kind === "category" ? "カテゴリー" : "タグ"));
      const groups = contentModel.taxonomy(articles, kind);
      if (!groups.size) root.append(createElement("p", {className:"muted"}, "登録はありません。"));
      groups.forEach((items, name) => {
        const detail = createElement("details", {className:"taxonomy-group"});
        detail.append(createElement("summary", {}, name + "（" + items.length + "件）"));
        items.forEach(a => detail.append(button(a.title || "タイトル未入力", () => {
          selectedArticle = a.id; articleMode = mode; articleRoute = "detail"; renderArticles();
        }, "text-button")));
        root.append(detail);
      });
    });
  }

  function renderSettings() {
    const root = $("#settings-fields"); root.replaceChildren();
    [["siteName", "サイト名（記事と固定ページで共通）"], ["title", "採用ページの検索表示用タイトル"], ["description", "採用ページの検索表示用説明"]].forEach(([key, label]) => {
      const id = "site-" + key;
      const input = createElement(key === "description" ? "textarea" : "input", {id, value:state.draft.settings[key], maxlength:"1000"});
      input.addEventListener("input", () => { state.draft.settings[key] = input.value; markDirty(); renderSeoSummary(); renderPagePreview(); renderArticlePreview(); });
      root.append(createElement("label", {for:id,className:"input-label"}, label), input);
    });
    renderSeoSummary();
    updateRoleControls();
  }
  function renderSeoSummary() {
    const root = $("#seo-summary"); root.replaceChildren();
    ["draft", "published"].forEach(mode => {
      const settings = state[mode].settings;
      const card = createElement("div", {className:"seo-card"});
      card.append(createElement("h3", {}, mode === "draft" ? "編集中" : "反映済み"), createElement("strong", {}, settings.title), createElement("p", {}, settings.description || "説明は未入力です。"), createElement("small", {}, "サイト名：" + settings.siteName));
      root.append(card);
    });
  }


  function renderFixedPages() {
    const root = $("#fixed-editor"); root.replaceChildren();
    const list = $("#fixed-items"); list.replaceChildren();
    contentModel.union(state.draft.pages, state.published.pages).forEach(page => list.append(button(page.title || "無題の固定ページ", () => {selectedPage=page.id;renderFixedPages();}, "article-item")));
    const draftPage = state.draft.pages.find(p => p.id === selectedPage);
    const page = draftPage || clone(state.published.pages.find(p => p.id === selectedPage) || null);
    if (!page) { root.append(createElement("p", {}, "固定ページを追加、または一覧から選択してください。")); return; }
    const form = createElement("div", {className:"article-form"});
    form.append(createElement("h2", {}, page.template === "recruit" ? "採用ページ" : "固定ページを編集"));
    [["title","ページ名"],["slug","URL名（半角英数字・ハイフン）"],["body","本文"],["seoTitle","検索表示用タイトル"],["seoDescription","検索表示用説明"]].filter(([key]) => page.template !== "recruit" || key !== "body").forEach(([key,label]) => {
      const id="fixed-"+key; const input=createElement(key === "body" || key === "seoDescription" ? "textarea" : "input", {id,value:page[key] || "",maxlength:key === "body" ? "60000" : "1000"});
      input.addEventListener("input", () => {if(role === "viewer")return;page[key]=key === "slug" ? input.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() : input.value;markDirty();renderFixedPreview();});
      form.append(createElement("label", {for:id,className:"input-label"},label),input);
    });
    const check=createElement("input", {type:"checkbox",checked:page.listed});check.addEventListener("change",()=>{if(role === "viewer")return;page.listed=check.checked;markDirty();renderFixedPreview();});
    const label=createElement("label",{className:"listing-option"},"次の反映で掲載する");label.prepend(check);form.append(label);
    if(page.template === "recruit") form.append(button("採用ページの内容を直接編集",()=>switchView("pages")));
    form.append(button("固定ページを削除",async()=>{if(role === "viewer")return;if(!await confirmAction("固定ページを下書きから削除しますか？反映済み表示は次の反映まで残ります。","削除"))return;if(role === "viewer")return;state.draft.pages=state.draft.pages.filter(p=>p.id!==page.id);markDirty();renderFixedPages();}));
    const preview=createElement("div",{className:"article-form"});
    const mode=createElement("select",{id:"fixed-mode","aria-label":"固定ページプレビューの版"});mode.append(createElement("option",{value:"draft"},"編集中"),createElement("option",{value:"published"},"反映済み"));if(!draftPage)mode.value="published";mode.addEventListener("change",renderFixedPreview);
    const frame=createElement("iframe",{id:"fixed-preview",title:"固定ページプレビュー",sandbox:"allow-same-origin"});
    if(!draftPage)form.replaceChildren(createElement("h2",{},"下書きから削除した固定ページ"),createElement("p",{},"反映済みの内容を確認できます。次のデモ反映で掲載が終了します。"));
    preview.append(mode,frame);root.append(form,preview);renderFixedPreview();updateRoleControls();
  }
  function renderFixedPreview() {
    const iframe=$("#fixed-preview");if(!iframe)return;
    const content=state[$("#fixed-mode").value];const page=content.pages.find(p=>p.id===selectedPage);
    const doc=source.cloneNode(true);applyFields(doc,content);
    const main=$("main",doc);
    const visible=page && ($("#fixed-mode").value === "draft" || page.listed);
    if(!visible || page.template !== "recruit") {
      const style=doc.createElement("style");
      style.textContent="main,footer{position:relative;background:#fff}main h1{font-size:32px;line-height:1.5;border-left:8px solid #ecdd6e;padding-left:20px;overflow-wrap:anywhere}main p{line-height:2;margin:24px 0}@media(max-width:700px){main h1{font-size:25px}main>section{padding:30px 22px 60px!important}}";
      doc.head.append(style);
      main.replaceChildren();const section=doc.createElement("section");section.style.cssText="padding:40px;max-width:900px;margin:auto;overflow-wrap:anywhere";
      const h=doc.createElement("h1");h.textContent=visible ? page.title : "この固定ページは掲載されていません";section.append(h);
      if(visible)page.body.split("\n").forEach(line=>{const p=doc.createElement("p");p.textContent=line;p.style.whiteSpace="pre-wrap";section.append(p);});main.append(section);
    }
    contentModel.head(doc,content.settings,{title:visible ? page.seoTitle || (page.template === "recruit" ? content.settings.title : page.title) : "未掲載の固定ページ",description:visible ? page.seoDescription || (page.template === "recruit" ? content.settings.description : "") : ""});
    iframe.srcdoc="<!doctype html>"+doc.documentElement.outerHTML;
  }
  function addFixedPage() {
    if(role === "viewer")return;
    const template="standard";
    const page={id:crypto.randomUUID(),title:"新しい固定ページ",slug:"page-"+Date.now(),template,body:"",listed:false,seoTitle:"",seoDescription:""};
    state.draft.pages.push(page);selectedPage=page.id;markDirty();renderFixedPages();
  }

  function updateRoleControls() {
    $$("input,textarea,button").forEach(target => {
      const publishAction = target.id === "confirm-publish" || target.id === "publish" || target.textContent.trim() === "デモに反映";
      const navigation = target.matches("[data-view],[data-device],[data-preview],.article-item,.text-button") || /スマホで見る|PCで見る|採用ページの内容を直接編集|戻る/.test(target.textContent);
      const blocked = (publishAction && role !== "admin") || (role === "viewer" && !navigation);
      if (blocked && !target.disabled) {target.disabled=true;target.dataset.roleDisabled="true";}
      else if (!blocked && target.dataset.roleDisabled) {target.disabled=false;delete target.dataset.roleDisabled;}
    });
  }

  function guardRole(event) {
    const target=event.target.closest("input,textarea,select,button,[contenteditable]");if(!target)return;
    const publishAction=target.id === "confirm-publish" || target.id === "publish" || target.textContent.trim() === "デモに反映";
    const navigation=target.matches("[data-view],[data-device],[data-preview],#role-select,#section-select,#taxonomy-mode,#fixed-mode,#fixed-template,[aria-label^='記事プレビュー'],.article-item,.text-button") || /スマホで見る|PCで見る|採用ページの内容を直接編集|戻る/.test(target.textContent);
    const mutation=!navigation && (target.matches("input,textarea,[contenteditable]") || target.tagName === "BUTTON");
    if((publishAction && role !== "admin") || (mutation && role === "viewer")) {event.preventDefault();event.stopImmediatePropagation();if(event.type === "click")toast("現在のデモ権限では変更できません。");}
  }

  function setDevice(value) {
    commitInlineEditors();
    device = value;
    $$("[data-device]").forEach((item) => item.classList.toggle("active", item.dataset.device === value));
    $("#preview-size").textContent = `${device === "mobile" ? 375 : 1080}px`;
    fitPreviews();
  }

  function switchView(value) {
    if(value === "pages" && !state.draft.pages.some(p => p.id === "recruit")) {toast("採用ページは削除されています。反映履歴から復元できます。");value="fixed";}
    commitInlineEditors();
    view = value;
    $$("[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === value));
    ["pages", "articles", "history", "settings", "fixed"].forEach((name) => { $(`#${name}-view`).hidden = name !== value; });
    $("#view-title").textContent = { pages: "ページを編集", articles: "記事をつくる", history: "反映履歴", settings: "サイト共通・SEO", fixed: "固定ページ管理" }[value];
    if (value === "articles") renderArticles();
    if (value === "history") renderHistory();
    if (value === "settings") renderSettings();
    if (value === "fixed") renderFixedPages();
    requestAnimationFrame(fitPreviews);
  }

  function exportData() {
    commitInlineEditors();
    const blob = new Blob([JSON.stringify({ schemaVersion: 1, siteId: "site-frame2", exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = createElement("a", { href: url, download: `frame-cms-${new Date().toISOString().slice(0, 10)}.json` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("編集データをJSONファイルに書き出しました。");
  }

  async function start() {
    state = { version: 1, draft: clone(initial), published: clone(initial), history: [], savedAt: null, publishedAt: null };
    try {
      db = await openDatabase();
      const saved = await readState();
      if (saved?.version === 1 && saved.draft && saved.published && Array.isArray(saved.history)) {
        ["draft", "published"].forEach((name) => {
          saved[name] = model.completeContent(saved[name], initial);
        });
        saved.history.forEach((entry) => { entry.content = model.completeContent(entry.content, initial); });
        state = saved;
      }
    } catch (error) {
      console.error("ブラウザ保存を開けませんでした", error);
      toast("ブラウザ保存を利用できません。編集後はJSONを書き出してください。");
    }
    selectedArticle = state.draft.articles[0]?.id || null;
    $("#add-fixed").addEventListener("click", addFixedPage);
    $("#role-select").addEventListener("change", event => {commitInlineEditors();role=event.target.value;status();updateRoleControls();renderPagePreview();renderFields();if(view === "articles")renderArticles();updateRoleControls();});
    new MutationObserver(updateRoleControls).observe(document.body,{childList:true,subtree:true});
    ["click","beforeinput","input","change"].forEach(type => document.addEventListener(type,guardRole,true));
    groups.forEach((group) => $("#section-select").append(createElement("option", { value: group.id }, group.label)));
    $("#section-select").value = selectedGroup;
    $("#section-select").addEventListener("change", (event) => selectGroup(event.target.value, null, true));
    $$("[data-view]").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.view)));
    $$("[data-device]").forEach((item) => item.addEventListener("click", () => setDevice(item.dataset.device)));
    $$("[data-preview]").forEach((item) => item.addEventListener("click", () => {
      commitInlineEditors();
      previewMode = item.dataset.preview;
      $$("[data-preview]").forEach((entry) => entry.classList.toggle("active", entry === item));
      renderPagePreview();
      renderFields();
      $("#editing-mode").textContent = previewMode === "draft" ? "クリックして直接編集" : "反映済み・閲覧専用";
      $("#inline-mode-label").textContent = previewMode === "draft" ? "ページ上で編集できます" : "閲覧専用・編集できません";
    }));
    $("#save").addEventListener("click", saveDraft);
    $("#publish").addEventListener("click", openPublish);
    $("#cancel-publish").addEventListener("click", () => $("#publish-dialog").close());
    $("#confirm-publish").addEventListener("click", publish);
    $("#export-data").addEventListener("click", exportData);
    $("#taxonomy-mode").addEventListener("change", renderTaxonomy);
    $("#add-article").addEventListener("click", () => newArticle());
    $("#preview").addEventListener("load", () => {
      $("#preview").contentWindow.scrollTo(0, pageScroll);
      const doc = $("#preview").contentDocument;
      attachInlineEditor(doc);
      fitPreviews();
    });
    new ResizeObserver(fitPreviews).observe($("#canvas"));
    window.addEventListener("resize", fitPreviews);
    window.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
    renderFields(); renderPagePreview(); renderHistory(); status();
    requestAnimationFrame(fitPreviews);
  }

  start().catch((error) => {
    console.error("画面の準備に失敗しました", error);
    $("#save-status").textContent = "画面の準備に失敗しました";
    toast("画面を準備できませんでした。再読み込みしてください。");
  });
})();
