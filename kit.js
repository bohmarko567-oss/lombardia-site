// Copy buttons. The text comes from data-copy, written server-side: reading it
// out of the DOM would pick up the CSS uppercasing and paste headings in caps.
document.addEventListener('click', function (e) {
  var b = e.target.closest('.cp');
  if (!b) return;
  navigator.clipboard.writeText(b.dataset.copy).then(function () {
    var was = b.textContent;
    b.textContent = 'Copied';
    b.classList.add('ok');
    setTimeout(function () { b.textContent = was; b.classList.remove('ok'); }, 1400);
  }).catch(function () { b.textContent = 'Copy failed'; });
});
