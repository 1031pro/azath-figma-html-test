# 編集方法

- templates/header.html: ヘッダー
- templates/main.html: 本文
- templates/footer.html: フッター
- templates/layout.html: ページ全体の枠・共通スクリプト
- style.css: スタイル

編集後に `python build.py` を実行すると、各部品を結合した index.html を生成します。
GitHub Pagesでは生成済みHTMLを配信するため、JavaScriptの読み込み待ちなくヘッダーとフッターを表示します。
