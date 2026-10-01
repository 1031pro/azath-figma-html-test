"use strict";

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clone = (value) => structuredClone(value);
  const source = new DOMParser().parseFromString(window.FRAME_SOURCE, "text/html");
  const siteBase = new URL("site/", location.href).href;
  const fields = [];
  const groups = [];
  const initial = { values: {}, images: {}, faqs: [], articles: [] };
  let state;
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
  let pageScroll = 0;
  let toastTimer;

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
    [data-cms-key], [data-faq-id] { cursor:pointer; }
    [data-cms-key]:hover, [data-faq-id]:hover { outline:2px dashed #498d65; outline-offset:3px; }
    .cms-selected { outline:3px solid #46865b !important; outline-offset:4px; }
    html { scroll-behavior:auto !important; }
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
    $("#save").disabled = busy;
    $("#publish").disabled = busy;
    $$(".article-actions button").forEach((item) => { item.disabled = busy; });
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
    if (busy) return;
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
    renderFAQDocument(doc, content);
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
        root.append(heading);
        previousCategory = faq.category;
      }
      const item = doc.createElement("details");
      item.open = true;
      item.dataset.faqId = faq.id;
      const question = doc.createElement("summary");
      question.textContent = faq.question;
      const answer = doc.createElement("div");
      answer.className = "answer";
      setText(answer, faq.answer);
      item.append(question, answer);
      root.append(item);
    });
  }

  function pageDocument(content) {
    const doc = source.cloneNode(true);
    applyFields(doc, content);
    return "<!doctype html>" + doc.documentElement.outerHTML;
  }

  function renderPagePreview() {
    pageScroll = $("#preview").contentWindow?.scrollY || 0;
    $("#preview").srcdoc = pageDocument(state[previewMode]);
  }

  function updatePreviewField(field) {
    if (previewMode !== "draft") return;
    const doc = $("#preview").contentDocument;
    const node = doc?.querySelector(`[data-cms-key="${field.key}"]`);
    if (!node) return;
    if (field.type === "image") {
      setImage(node, state.draft.images[field.key]);
    } else setText(node, state.draft.values[field.key], field.ownText);
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
    if (key) {
      const control = document.getElementById(`input-${key}`);
      control?.scrollIntoView({ block: "nearest" });
      control?.focus({ preventScroll: true });
    }
  }

  function renderFields() {
    const root = $("#fields");
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

  function syncFAQ() {
    if (previewMode === "draft") renderFAQDocument($("#preview").contentDocument, state.draft);
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
    return { textCount, imageCount, faqChanged, articleChanged, removedArticles };
  }

  function openPublish() {
    const changes = changesSummary();
    const root = $("#changes");
    root.replaceChildren();
    root.append(createElement("p", {}, `文章 ${changes.textCount}項目 / 画像・説明 ${changes.imageCount}項目`));
    root.append(createElement("p", {}, changes.faqChanged ? `FAQを更新（${state.draft.faqs.length}件）` : "FAQの変更なし"));
    root.append(createElement("p", {}, `記事の追加・更新 ${changes.articleChanged}件 / 削除 ${changes.removedArticles}件`));
    root.append(createElement("p", {}, `掲載設定の記事 ${state.draft.articles.filter((article) => article.listed).length}件を読者向け一覧に表示します。`));
    $("#publish-dialog").showModal();
  }

  async function publish() {
    if (busy) return;
    if (!db) return toast("ブラウザ保存を利用できないため反映できません。");
    const listed = state.draft.articles.filter((article) => article.listed);
    const invalid = listed.find((article) => !article.title.trim() || !article.body.trim() || !article.slug.trim());
    if (invalid) { toast("掲載する記事のタイトル・URL名・本文を入力してください。"); return; }
    if (new Set(listed.map((article) => article.slug)).size !== listed.length) { toast("掲載する記事のURL名が重複しています。"); return; }
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
      renderArticleItems(); renderArticlePreview(); renderHistory();
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
        state.draft = clone(entry.content);
        selectedArticle = state.draft.articles[0]?.id || null;
        markDirty(); renderFields(); renderPagePreview(); renderArticles();
        await saveDraft();
      }));
      root.append(card);
    });
  }

  function newArticle(sample = false) {
    const article = {
      id: crypto.randomUUID(), title: sample ? "院内見学の前に確認したいこと" : "", slug: `article-${Date.now()}`,
      summary: sample ? "見学前に整理しておくと役立つ質問を紹介します。" : "",
      body: sample ? "院内見学では、職場の雰囲気やスタッフの動きを実際に確認できます。\n\n## 先に質問を整理する\n\n研修の進め方、勤務時間、配属先など、知りたいことをメモしておきましょう。\n\n## 現場の様子を見る\n\n患者さんへの説明やスタッフ同士のやり取りを見て、自分に合う職場か考えてみましょう。\n\n※操作確認のための固定サンプルです。掲載前に内容を確認してください。" : "",
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
    state.draft.articles.forEach((article) => {
      const item = button("", () => { selectedArticle = article.id; articleRoute = "detail"; renderArticles(); }, `article-item${selectedArticle === article.id ? " active" : ""}`);
      item.append(createElement("strong", {}, article.title || "タイトル未入力"));
      const live = state.published.articles.find((entry) => entry.id === article.id);
      const label = !live ? "未反映" : JSON.stringify(live) !== JSON.stringify(article) ? "変更あり" : "反映済み";
      item.append(createElement("small", {}, `${article.listed ? "掲載する" : "下書き"} · ${label}`));
      root.append(item);
    });
  }

  function renderArticles() {
    renderArticleItems();
    const root = $("#article-editor");
    root.replaceChildren();
    const article = state.draft.articles.find((item) => item.id === selectedArticle);
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
    [["title", "タイトル", "input"], ["slug", "URL名（半角英数字・ハイフン）", "input"], ["summary", "概要", "textarea"], ["body", "本文（行頭の ## は見出しになります）", "textarea"], ["author", "著者", "input"], ["date", "記事の日付", "input"]].forEach(([key, label, tag]) => {
      const id = `article-${key}`;
      const control = createElement(tag, { id, value: article[key], className: key === "summary" ? "summary-input" : "", maxlength: key === "body" ? "60000" : "1000" });
      if (key === "date") control.type = "date";
      control.addEventListener("input", () => {
        article[key] = key === "slug" ? control.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() : control.value;
        if (key === "slug") control.value = article[key];
        article.updatedAt = new Date().toISOString();
        markDirty(); renderArticleItems(); renderArticlePreview();
      });
      form.append(createElement("label", { for: id, className: "input-label" }, label), control);
    });
    const listing = createElement("label", { className: "listing-option" });
    const checkbox = createElement("input", { type: "checkbox", checked: article.listed });
    checkbox.addEventListener("change", () => { article.listed = checkbox.checked; article.updatedAt = new Date().toISOString(); markDirty(); renderArticleItems(); renderArticlePreview(); });
    listing.append(checkbox, document.createTextNode("次のデモ反映で記事一覧に掲載する"));
    form.append(listing, createElement("p", { className: "muted" }, "チェックを外した記事は下書きとして保存され、反映済みの記事一覧には表示されません。"));
    const controls = createElement("div", { className: "article-actions" });
    controls.append(button("下書き保存", saveDraft), button("デモに反映", openPublish, "btn small primary"), button("削除", async () => {
      if (!await confirmAction("この記事を下書きから削除しますか？反映済みの記事は次の反映まで残ります。", "下書きから削除")) return;
      state.draft.articles = state.draft.articles.filter((item) => item.id !== article.id);
      selectedArticle = state.draft.articles[0]?.id || null;
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
    [["detail", "記事詳細"], ["list", "記事一覧"]].forEach(([value, label]) => route.append(createElement("option", { value }, label)));
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
        else if (link.dataset.articleList !== undefined) { articleRoute = "list"; renderArticles(); }
        else toast("記事プレビューでは記事一覧・詳細の移動を確認できます。");
      });
    });
    holder.append(iframe); canvas.append(holder); preview.append(toolbar, canvas);
    root.append(form, preview);
    renderArticlePreview();
    requestAnimationFrame(fitPreviews);
  }

  function renderArticlePreview() {
    const iframe = $("#article-preview-frame");
    if (!iframe) return;
    const routeKey = `${articleMode}:${articleRoute}:${selectedArticle}`;
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
    if (articleRoute === "list") {
      append("h1", "採用コラム・お知らせ");
      const listed = content.articles.filter((item) => item.listed);
      if (!listed.length) append("p", "掲載する記事はまだありません。");
      listed.forEach((item) => {
        const card = doc.createElement("div"); card.className = "reader-card";
        const link = append("a", item.title || "タイトル未入力", append("h2", "", card));
        link.href = `#${item.slug}`; link.dataset.articleId = item.id;
        append("small", `${item.date} / ${item.author}`, card);
        append("p", item.summary, card);
        root.append(card);
      });
    } else if (article && (articleMode === "draft" || article.listed)) {
      append("h1", article.title || "タイトル未入力");
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
    doc.title = articleRoute === "list" ? "採用コラム・お知らせ" : article?.title || "記事プレビュー";
    iframe.srcdoc = "<!doctype html>" + doc.documentElement.outerHTML;
  }

  function setDevice(value) {
    device = value;
    $$("[data-device]").forEach((item) => item.classList.toggle("active", item.dataset.device === value));
    $("#preview-size").textContent = `${device === "mobile" ? 375 : 1080}px`;
    fitPreviews();
  }

  function switchView(value) {
    view = value;
    $$("[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === value));
    ["pages", "articles", "history"].forEach((name) => { $(`#${name}-view`).hidden = name !== value; });
    $("#view-title").textContent = { pages: "ページを編集", articles: "記事をつくる", history: "反映履歴" }[value];
    if (value === "articles") renderArticles();
    if (value === "history") renderHistory();
    requestAnimationFrame(fitPreviews);
  }

  function exportData() {
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
          saved[name].values = { ...initial.values, ...saved[name].values };
          saved[name].images = { ...initial.images, ...saved[name].images };
        });
        state = saved;
      }
    } catch (error) {
      console.error("ブラウザ保存を開けませんでした", error);
      toast("ブラウザ保存を利用できません。編集後はJSONを書き出してください。");
    }
    selectedArticle = state.draft.articles[0]?.id || null;
    groups.forEach((group) => $("#section-select").append(createElement("option", { value: group.id }, group.label)));
    $("#section-select").value = selectedGroup;
    $("#section-select").addEventListener("change", (event) => selectGroup(event.target.value, null, true));
    $$("[data-view]").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.view)));
    $$("[data-device]").forEach((item) => item.addEventListener("click", () => setDevice(item.dataset.device)));
    $$("[data-preview]").forEach((item) => item.addEventListener("click", () => {
      previewMode = item.dataset.preview;
      $$("[data-preview]").forEach((entry) => entry.classList.toggle("active", entry === item));
      renderPagePreview();
    }));
    $("#save").addEventListener("click", saveDraft);
    $("#publish").addEventListener("click", openPublish);
    $("#cancel-publish").addEventListener("click", () => $("#publish-dialog").close());
    $("#confirm-publish").addEventListener("click", publish);
    $("#export-data").addEventListener("click", exportData);
    $("#add-article").addEventListener("click", () => newArticle());
    $("#preview").addEventListener("load", () => {
      $("#preview").contentWindow.scrollTo(0, pageScroll);
      const doc = $("#preview").contentDocument;
      doc.addEventListener("click", (event) => {
        const target = event.target.closest("[data-cms-key], [data-faq-id]");
        if (target) {
          event.preventDefault();
          const faqId = target.dataset.faqId;
          const field = fields.find((entry) => entry.key === target.dataset.cmsKey);
          selectGroup(faqId ? "faq" : field?.group || selectedGroup, target.dataset.cmsKey);
          if (faqId) document.getElementById(`form-${faqId}`)?.scrollIntoView({ block: "nearest" });
          return;
        }
        const link = event.target.closest("a,button");
        if (link) { event.preventDefault(); toast("プレビュー内のリンク・送信操作は編集用です。"); }
      });
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
