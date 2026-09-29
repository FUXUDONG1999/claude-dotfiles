// 课件站交互：左侧目录树点选文档、右侧 iframe 阅读（不跳页）、顶部标题检索。
// 中文检索按子串匹配（天然等价分词），全部计算在浏览器端完成。
// 索引仅含 title/path（增量累积部署，清单以云端 search-index.json 为权威），故检索只匹配标题。
// 移动端（≤900px）：目录为滑出抽屉，☰ 呼出，遮罩/✕/选中课件后收起（body.nav-open 仅在小屏媒体查询内生效）。
(function () {
  var contentFrame = document.getElementById('content-frame');
  var docsTree = document.getElementById('docs-tree');
  var searchInput = document.getElementById('site-search-input');
  var searchResultContainer = document.getElementById('search-result-container');
  var navToggleButton = document.getElementById('nav-toggle');
  var navCloseButton = document.getElementById('nav-close');
  var navBackdrop = document.getElementById('nav-backdrop');
  if (!contentFrame || !docsTree) return;

  var searchIndex = [];
  var navigationLinks = Array.prototype.slice.call(docsTree.querySelectorAll('a[data-path]'));

  function escapeHtml(text) {
    var escapeDivElement = document.createElement('div');
    escapeDivElement.textContent = text;
    return escapeDivElement.innerHTML;
  }

  function highlightQuery(escapedText, query) {
    var safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escapedText.replace(new RegExp('(' + safeQuery + ')', 'gi'), '<span class="highlight">$1</span>');
  }

  function setActiveLink(path) {
    navigationLinks.forEach(function (link) {
      link.classList.toggle('active', link.getAttribute('data-path') === path);
    });
  }

  function setNavOpen(isOpen) {
    document.body.classList.toggle('nav-open', isOpen);
    if (navToggleButton) navToggleButton.setAttribute('aria-expanded', String(isOpen));
  }

  function openDocument(path) {
    contentFrame.src = path;
    setActiveLink(path);
    history.replaceState(null, '', '#' + path);
    setNavOpen(false);
  }

  docsTree.addEventListener('click', function (event) {
    var link = event.target.closest('a[data-path]');
    if (!link) return;
    event.preventDefault();
    openDocument(link.getAttribute('data-path'));
  });

  if (navToggleButton) {
    navToggleButton.addEventListener('click', function () {
      setNavOpen(!document.body.classList.contains('nav-open'));
    });
  }
  if (navCloseButton) {
    navCloseButton.addEventListener('click', function () { setNavOpen(false); });
  }
  if (navBackdrop) {
    navBackdrop.addEventListener('click', function () { setNavOpen(false); });
  }

  searchResultContainer.addEventListener('click', function (event) {
    var link = event.target.closest('a[data-path]');
    if (!link) return;
    event.preventDefault();
    openDocument(link.getAttribute('data-path'));
    searchInput.value = '';
    renderSearchResults('');
  });

  function searchPages(query) {
    var normalizedQuery = query.trim().toLowerCase();
    var matches = [];
    searchIndex.forEach(function (page) {
      if (page.title.toLowerCase().indexOf(normalizedQuery) >= 0) {
        matches.push(page);
      }
    });
    return matches;
  }

  function renderSearchResults(query) {
    var normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      searchResultContainer.hidden = true;
      searchResultContainer.innerHTML = '';
      docsTree.hidden = false;
      return;
    }

    var matches = searchPages(query);
    var resultHtml;
    if (matches.length === 0) {
      resultHtml = '<p class="search-empty">未找到与「' + escapeHtml(query) + '」相关的课件</p>';
    } else {
      var listItems = matches.map(function (match) {
        return '<li><a data-path="' + escapeHtml(match.path) + '">' +
          highlightQuery(escapeHtml(match.title), query) + '</a></li>';
      });
      resultHtml = '<ul class="docs-list">' + listItems.join('') + '</ul>';
    }

    docsTree.hidden = true;
    searchResultContainer.hidden = false;
    searchResultContainer.innerHTML = resultHtml;
  }

  fetch('search-index.json')
    .then(function (response) { return response.json(); })
    .then(function (data) {
      searchIndex = data.pages || [];
      searchInput.disabled = false;
      searchInput.placeholder = '搜索课件标题…';
    });

  searchInput.addEventListener('input', function () {
    renderSearchResults(searchInput.value);
  });

  // 初始加载：URL hash 直达指定课件，否则打开第一篇
  var initialPath = decodeURIComponent(location.hash.slice(1));
  var isValidPath = navigationLinks.some(function (link) { return link.getAttribute('data-path') === initialPath; });
  if (!isValidPath) {
    initialPath = navigationLinks.length ? navigationLinks[0].getAttribute('data-path') : '';
  }
  if (initialPath) {
    openDocument(initialPath);
  }
})();
