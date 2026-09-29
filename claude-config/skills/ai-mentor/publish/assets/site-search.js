// 课件站客户端全文检索：数据源是构建期生成的 search-index.json（与首页同源，无跨域问题）。
// 中文按子串匹配（天然等价于分词），英文统一转小写后匹配；全部计算在浏览器端完成。
(function () {
  var searchInput = document.getElementById('site-search-input');
  var groupContainer = document.getElementById('group-container');
  var resultContainer = document.getElementById('search-result-container');
  if (!searchInput || !groupContainer || !resultContainer) return;

  var searchIndex = [];

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
    var normalizedContent = content.toLowerCase();
    var position = normalizedContent.indexOf(query);
    if (position < 0) return '';
    var start = Math.max(0, position - 30);
    var end = Math.min(content.length, position + query.length + 60);
    var prefix = start > 0 ? '…' : '';
    var suffix = end < content.length ? '…' : '';
    return prefix + content.slice(start, end) + suffix;
  }

  function searchPages(query) {
    var normalizedQuery = query.trim().toLowerCase();
    var matches = [];
    for (var pageIndex = 0; pageIndex < searchIndex.length; pageIndex++) {
      var page = searchIndex[pageIndex];
      var titleHit = page.title.toLowerCase().indexOf(normalizedQuery) >= 0;
      var groupHit = page.group.toLowerCase().indexOf(normalizedQuery) >= 0;
      var contentHit = page.content.toLowerCase().indexOf(normalizedQuery) >= 0;
      if (titleHit || groupHit || contentHit) {
        var weight = (titleHit ? 100 : 0) + (groupHit ? 10 : 0) + (contentHit ? 1 : 0);
        matches.push({ page: page, weight: weight });
      }
    }
    matches.sort(function (left, right) { return right.weight - left.weight; });
    return matches;
  }

  function renderSearchResults(query) {
    var normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      resultContainer.hidden = true;
      groupContainer.hidden = false;
      resultContainer.innerHTML = '';
      return;
    }

    var matches = searchPages(query);
    var resultHtml;
    if (matches.length === 0) {
      resultHtml = '<p class="search-empty">未找到与「' + escapeHtml(query) + '」相关的课件</p>';
    } else {
      var listItems = matches.map(function (match) {
        var summary = buildSummary(match.page.content, normalizedQuery);
        var summaryHtml = summary
          ? '<span class="search-summary">' + highlightQuery(escapeHtml(summary), query) + '</span>'
          : '';
        return '<li class="with-summary"><a href="' + escapeHtml(match.page.path) + '">' +
          highlightQuery(escapeHtml(match.page.title), query) + '</a>' + summaryHtml +
          '<span class="index-date">' + escapeHtml(match.page.group) + '</span></li>';
      });
      resultHtml = '<ul class="index-list">' + listItems.join('') + '</ul>';
    }

    groupContainer.hidden = true;
    resultContainer.hidden = false;
    resultContainer.innerHTML = resultHtml;
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
})();
