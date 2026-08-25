function collectPageData() {
  return {
    title: document.title,
    h1: document.querySelector('h1')?.innerText || null,
    textLength: document.body.innerText.length,
    linksCount: document.querySelectorAll('a').length,
    inputsCount: document.querySelectorAll('input, textarea').length,
    hasVideo: document.querySelectorAll('video').length > 0
  };
}

chrome.runtime.sendMessage({
  type: 'PAGE_DATA',
  payload: collectPageData()
});
