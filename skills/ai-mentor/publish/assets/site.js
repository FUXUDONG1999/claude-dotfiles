// 课件站交互：左侧目录树点选文档、右侧 iframe 阅读（不跳页）、顶部全文检索。
// 中文检索按子串匹配（天然等价分词），全部计算在浏览器端完成。
(function () {
  var contentFrame = document.getElementById('content-frame');
  var docsTree = document.getElementById('docs-tree');
  var searchInput = document.getElementById('site-search-input');
  var searchResultContainer = document.getElementById('search-result-container');
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

  function buildSummary(content, query) {
    var position = content.toLowerCase().indexOf(query);
    if (position < 0) return '';
    var start = Math.max(0, position - 30);
    var end = Math.min(content.length, position + query.length + 60);
    return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
  }

  function setActiveLink(path) {
    navigationLinks.forEach(function (link) {
      link.classList.toggle('active', link.getAttribute('data-path') === path);
    });
  }

  function openDocument(path) {
    contentFrame.src = path;
    setActiveLink(path);
    history.replaceState(null, '', '#' + path);
  }

  docsTree.addEventListener('click', function (event) {
    var link = event.target.closest('a[data-path]');
    if (!link) return;
    event.preventDefault();
    openDocument(link.getAttribute('data-path'));
  });

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
      var titleHit = page.title.toLowerCase().indexOf(normalizedQuery) >= 0;
      var groupHit = page.group.toLowerCase().indexOf(normalizedQuery) >= 0;
      var contentPosition = page.content.toLowerCase().indexOf(normalizedQuery);
      if (titleHit || groupHit || contentPosition >= 0) {
        matches.push({ page: page, weight: (titleHit ? 100 : 0) + (groupHit ? 10 : 0) + 1 });
      }
    });
    matches.sort(function (left, right) { return right.weight - left.weight; });
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
        var summary = buildSummary(match.page.content, normalizedQuery);
        var summaryHtml = summary ? '<span class="search-summary">' + highlightQuery(escapeHtml(summary), query) + '</span>' : '';
        return '<li><a data-path="' + escapeHtml(match.page.path) + '">' +
          highlightQuery(escapeHtml(match.page.title), query) + '</a>' + summaryHtml + '</li>';
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
      searchInput.placeholder = '搜索全部课件（标题 / 分类 / 正文）…';
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
