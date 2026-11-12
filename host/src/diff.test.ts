import { describe, expect, it } from 'vitest';
import { diffHtml, summarize } from './diff.js';

/** The marked HTML for two versions, as the review gets it. */
const marked = (before: string, after: string) => diffHtml(before, after).html;
/** The marked HTML with the folds and the sheets of the review. */
const review = (before: string, after: string) => diffHtml(before, after, { review: true }).html;

describe('words in a text block', () => {
  it('marks the words that replace other words', () => {
    expect(marked('<p>The path to 1,000 costs about $2.</p>', '<p>The path to 1,000 costs about 30 cents.</p>'))
      .toBe('<p data-diff="mod" data-diff-n="1">The path to 1,000 costs about <del data-diff>$2</del><ins data-diff>30 cents</ins>.</p>');
  });

  it('marks a new sentence at the end as one insertion', () => {
    expect(marked('<p>We read the email from the site.</p>', '<p>We read the email from the site. In our test, 88% were right.</p>'))
      .toBe('<p data-diff="mod" data-diff-n="1">We read the email from the site. <ins data-diff>In our test, 88% were right.</ins></p>');
  });

  it('keeps a removed word at its place, with the space that followed it', () => {
    expect(marked('<p>We find almost no copywriters.</p>', '<p>We find no copywriters.</p>'))
      .toBe('<p data-diff="mod" data-diff-n="1">We find <del data-diff>almost </del>no copywriters.</p>');
  });

  it('keeps the space before removed words when the newer text has none at that place', () => {
    expect(marked('<p>This needs a small top-up.</p>', '<p>This.</p>'))
      .toBe('<p data-diff="mod" data-diff-n="1">This<del data-diff> needs a small top-up</del>.</p>');
  });

  it('removes a whole sentence, not the end of one and the start of the next', () => {
    expect(marked('<p>One stays. Two goes. Three stays.</p>', '<p>One stays. Three stays.</p>'))
      .toBe('<p data-diff="mod" data-diff-n="1">One stays. <del data-diff>Two goes. </del>Three stays.</p>');
  });

  it('shows one replacement when only one short word of a sentence stays', () => {
    expect(marked('<p>Our balance is about $0.44, so this needs a small top-up.</p>', '<p>Our balance is about $0.44 and covers this.</p>'))
      .toBe('<p data-diff="mod" data-diff-n="1">Our balance is about $0.44 <del data-diff>, so this needs a small top-up</del><ins data-diff>and covers this</ins>.</p>');
  });

  it('keeps two edits apart when the words between them stay', () => {
    expect(marked('<h2>Every fetch lands unchanged in R2 before an Adapter parses it.</h2>', '<h2>Every fetch lands in R2 first. Then an Adapter parses it.</h2>'))
      .toBe('<h2 data-diff="mod" data-diff-n="1">Every fetch lands <del data-diff>unchanged </del>in R2 <del data-diff>before</del><ins data-diff>first. Then</ins> an Adapter parses it.</h2>');
  });

  it('puts the marks inside the inline elements of the newer text', () => {
    expect(marked('<p><b>Spend about $2 on searches.</b> We find few.</p>', '<p><b>Spend about 30 cents on searches.</b> We find few.</p>'))
      .toBe('<p data-diff="mod" data-diff-n="1"><b>Spend about <del data-diff>$2</del><ins data-diff>30 cents</ins> on searches.</b> We find few.</p>');
  });

  it('reads entities as text and never reads the content of a script', () => {
    const script = '<script>const t = "<p>not a tag</p>";</script>';
    expect(marked('<p>Fish &amp; chips cost &lt; $5.</p>' + script, '<p>Fish &amp; chips cost &lt; $6.</p>' + script))
      .toBe('<p data-diff="mod" data-diff-n="1">Fish &amp; chips cost &lt; $<del data-diff>5</del><ins data-diff>6</ins>.</p>' + script);
  });

  it('marks text that stands between blocks, and its first mark holds the number', () => {
    const card = (chip: string) => '<div class="k-card"><span class="k-chip">' + chip + '</span><h3>Apollo</h3><p>A sales database.</p></div>';
    const out = diffHtml(card('free, not tested yet'), card('free, tested Nov 11'));
    expect(out.html).toBe('<div class="k-card"><span class="k-chip">free, <del data-diff data-diff-n="1">not </del>tested <del data-diff>yet</del><ins data-diff>Nov 11</ins></span><h3>Apollo</h3><p>A sales database.</p></div>');
    // The chip stands above the title of its card, so the change belongs to "Apollo".
    expect(out.changes).toEqual([{ n: 1, kind: 'mod', noun: 'text', heading: 'Apollo', level: 3, slide: 0, text: 'Nov 11', was: 'not yet' }]);
  });
});

describe('blocks', () => {
  it('marks a changed heading, a new paragraph and a removed item, and numbers them in page order', () => {
    const out = diffHtml(
      '<h2>Plan</h2><p>First.</p><ul><li>One</li><li>Two</li><li>Three</li></ul>',
      '<h2>The plan</h2><p>First.</p><p>Second.</p><ul><li>One</li><li>Three</li></ul>',
    );
    expect(out.html).toBe('<h2 data-diff="mod" data-diff-n="1"><del data-diff>Plan</del><ins data-diff>The plan</ins></h2><p>First.</p><p data-diff="add" data-diff-n="2">Second.</p><ul><li>One</li><li data-diff="del" data-diff-n="3">Two</li><li>Three</li></ul>');
    expect(out.stops).toBe(3);
    expect(out.changes).toEqual([
      { n: 1, kind: 'mod', noun: 'heading', heading: 'The plan', level: 2, slide: 0, text: 'The plan', was: 'Plan' },
      { n: 2, kind: 'add', noun: 'paragraph', heading: 'The plan', level: 2, slide: 0, text: 'Second.', was: '' },
      { n: 3, kind: 'del', noun: 'item', heading: 'The plan', level: 2, slide: 0, text: 'Two', was: '' },
    ]);
  });

  it('gives the newer version back, byte for byte, when nothing that shows changed', () => {
    const page = '<!doctype html><html><head><title>T</title></head><body><main><h1>Title</h1><p>Same  text.</p></main></body></html>';
    expect(diffHtml(page, page)).toMatchObject({ html: page, changes: [], stops: 0 });
    // White space between words and between blocks does not show.
    const loose = '<p>Same text.</p><p>More.</p>';
    expect(diffHtml('<p>Same  text.</p>\n<p>More.</p>', loose)).toMatchObject({ html: loose, changes: [], stops: 0 });
  });

  it('marks only the body, and gives the head of the newer version back', () => {
    const page = (title: string, text: string) => '<!doctype html><html><head><title>' + title + '</title></head><body class="x">\n<main><h1>Title</h1><p>' + text + '</p></main>\n</body></html>';
    const out = diffHtml(page('Old', 'Old text.'), page('New', 'New text.'));
    expect(out.head).toBe('<!doctype html><html><head><title>New</title></head><body class="x">');
    expect(out.body).toBe('\n<main><h1>Title</h1><p data-diff="mod" data-diff-n="1"><del data-diff>Old</del><ins data-diff>New</ins> text.</p></main>\n');
    expect(out.tail).toBe('</body></html>');
    expect(out.html).toBe(out.head + out.body + out.tail);
    expect(out.changes[0]).toMatchObject({ heading: 'Title', level: 1 });
  });

  it('gives the cells of one table row one number', () => {
    const table = (fit: string, email: string) => '<table><tr><th>Source</th><th>Fit</th><th>Email</th></tr><tr><td>Clubs</td><td>70%</td><td>55%</td></tr><tr><td>Apollo</td><td>' + fit + '</td><td>' + email + '</td></tr></table>';
    const out = diffHtml(table('not tested', 'not tested'), table('88%', '41%'));
    expect(out.html).toBe('<table><tr><th>Source</th><th>Fit</th><th>Email</th></tr><tr><td>Clubs</td><td>70%</td><td>55%</td></tr><tr data-diff-n="1"><td>Apollo</td><td data-diff="mod"><del data-diff>not tested</del><ins data-diff>88%</ins></td><td data-diff="mod"><del data-diff>not tested</del><ins data-diff>41%</ins></td></tr></table>');
    expect(out.stops).toBe(1);
    expect(out.changes.map((c) => [c.n, c.noun, c.text, c.was])).toEqual([[1, 'cell', '88%', 'not tested'], [1, 'cell', '41%', 'not tested']]);
  });

  it('marks a block that moved at its new place only', () => {
    const a = '<p>Alpha is the first long paragraph here.</p>', b = '<p>Beta is the second one.</p>', c = '<p>Gamma is the third one.</p>';
    const out = diffHtml(a + b + c, b + c + a);
    expect(out.html).toBe(b + c + '<p data-diff="to" data-diff-n="1">Alpha is the first long paragraph here.</p>');
    expect(out.changes).toEqual([{ n: 1, kind: 'move', noun: 'paragraph', heading: '', level: 0, slide: 0, text: 'Alpha is the first long paragraph here.', was: '' }]);
  });

  it('does not read the ids that the host adds by position as a change', () => {
    const claim = (n: number, h: string, p: string) => '<section class="k-claim" id="claim-' + n + '"><h2>' + h + '</h2><p>' + p + '</p></section>';
    expect(marked(claim(1, 'A', 'Text one.') + claim(2, 'B', 'Text two.'), claim(1, 'New', 'Words here.') + claim(2, 'A', 'Text one.') + claim(3, 'B', 'Text two.')))
      .toBe('<section class="k-claim" id="claim-1" data-diff="add" data-diff-n="1"><h2>New</h2><p>Words here.</p></section>' + claim(2, 'A', 'Text one.') + claim(3, 'B', 'Text two.'));
  });

  it('reads two blocks with the id of the author as one block, although no word stayed', () => {
    expect(marked('<section id="cost"><h2>Cost</h2><p>It costs two dollars in total.</p></section>', '<section id="cost"><h2>Price</h2><p>We pay thirty cents for all of it.</p></section>'))
      .toBe('<section id="cost"><h2 data-diff="mod" data-diff-n="1"><del data-diff>Cost</del><ins data-diff>Price</ins></h2><p data-diff="mod" data-diff-n="2"><del data-diff>It costs two dollars in total</del><ins data-diff>We pay thirty cents for all of it</ins>.</p></section>');
  });
});

describe('parts that draw differently', () => {
  it('marks an inline element with other attributes', () => {
    const out = diffHtml('<p><span class="k-chip c-amber">to verify</span> Check the build.</p>', '<p><span class="k-chip c-green">to verify</span> Check the build.</p>');
    expect(out.html).toBe('<p data-diff="mod" data-diff-n="1"><span class="k-chip c-green" data-diff="obj">to verify</span> Check the build.</p>');
    expect(out.changes).toEqual([{ n: 1, kind: 'obj', noun: 'paragraph', heading: '', level: 0, slide: 0, text: 'to verify Check the build.', was: '' }]);
  });

  it('marks an image that changed on the image itself', () => {
    const out = diffHtml('<figure><img src="/a.png"><figcaption>The chart</figcaption></figure>', '<figure><img src="/b.png"><figcaption>The chart</figcaption></figure>');
    expect(out.html).toBe('<figure><img src="/b.png" data-diff="obj" data-diff-n="1"><figcaption>The chart</figcaption></figure>');
    expect(summarize(out.changes)).toEqual([{ n: 1, slide: 0, gone: false, heading: '', level: 0, what: 'Image changed' }]);
  });

  it('marks the block of a diagram that the kit draws from text, and leaves the text as written', () => {
    const flow = (node: string) => '<h2>Steps</h2><div class="k-flow"><script type="text/plain">\nfind = 1 Find / ' + node + '\nfind -> mail\n</script></div>';
    const out = diffHtml(flow('clubs, maps'), flow('clubs, maps, Apollo'));
    expect(out.html).toBe('<h2>Steps</h2><div class="k-flow" data-diff="obj" data-diff-n="1"><script type="text/plain">\nfind = 1 Find / clubs, maps, Apollo\nfind -> mail\n</script></div>');
    expect(out.changes).toEqual([{ n: 1, kind: 'obj', noun: 'diagram', heading: 'Steps', level: 2, slide: 0, text: '', was: '' }]);
  });

  it('pairs the cells of a chart row by row: a new row is new, and a changed row shows its own changes', () => {
    const row = (label: string, tone: string, v: number, value: string) => '\n  <b>' + label + '</b><span class="c-' + tone + '" style="--v:' + v + '"></span><output>' + value + '</output>';
    const bars = (rows: string) => '<div class="k-bars">' + rows + '\n</div>';
    const clubs = row('Clubs', 'teal', 35, '177');
    const out = diffHtml(bars(clubs + row('55 LinkedIn searches', 'purple', 50, '250')), bars(clubs + row('40 Apollo searches', 'amber', 36, '180') + row('15 LinkedIn searches', 'purple', 14, '70')));
    expect(out.html).toBe('<div class="k-bars" data-diff="mod" data-diff-n="1">' + clubs
      + '\n  <b data-diff="add">40 Apollo searches</b><span class="c-amber" style="--v:36" data-diff="add"></span><output data-diff="add">180</output>'
      + '\n  <b><del data-diff>55</del><ins data-diff>15</ins> LinkedIn searches</b><span class="c-purple" style="--v:14" data-diff="obj"></span><output><del data-diff>250</del><ins data-diff>70</ins></output>'
      + '\n</div>');
    expect(out.changes).toEqual([{ n: 1, kind: 'mod', noun: 'chart', heading: '', level: 0, slide: 0, text: '40 Apollo searches 180 15 70', was: '55 250' }]);
  });

  it('marks a heading with another level as changed', () => {
    expect(marked('<h2>Results</h2><p>x</p>', '<h3>Results</h3><p>x</p>')).toBe('<h3 data-diff="obj" data-diff-n="1">Results</h3><p>x</p>');
  });
});

describe('the review of a document', () => {
  const section = (h: string, ps: string[]) => '<section><h2>' + h + '</h2>' + ps.map((p) => '<p>' + p + '</p>').join('') + '</section>';
  const page = (c5: string) => '<main>' + section('One', ['a1', 'a2']) + section('Two', ['b1', 'b2']) + section('Three', ['c1', 'c2', 'c3', 'c4', c5, 'c6', 'c7', 'c8', 'c9']) + section('Four', ['d1']) + section('Five', ['e1']) + '</main>';

  it('folds the long stretches with no change, and keeps the heading and one block on each side of the change', () => {
    expect(review(page('c5 is old'), page('c5 is new'))).toBe('<main>'
      + '<div data-diff-gap="1"><button type="button">2 sections with no changes</button></div>'
      + '<section data-diff-skip="1"><h2>One</h2><p>a1</p><p>a2</p></section><section data-diff-skip="1"><h2>Two</h2><p>b1</p><p>b2</p></section>'
      + '<section><h2>Three</h2>'
      + '<div data-diff-gap="2"><button type="button">3 paragraphs with no changes</button></div>'
      + '<p data-diff-skip="2">c1</p><p data-diff-skip="2">c2</p><p data-diff-skip="2">c3</p>'
      + '<p>c4</p><p data-diff="mod" data-diff-n="1">c5 is <del data-diff>old</del><ins data-diff>new</ins></p><p>c6</p>'
      + '<div data-diff-gap="3"><button type="button">3 paragraphs with no changes</button></div>'
      + '<p data-diff-skip="3">c7</p><p data-diff-skip="3">c8</p><p data-diff-skip="3">c9</p></section>'
      + '<div data-diff-gap="4"><button type="button">2 sections with no changes</button></div>'
      + '<section data-diff-skip="4"><h2>Four</h2><p>d1</p></section><section data-diff-skip="4"><h2>Five</h2><p>e1</p></section>'
      + '</main>');
  });

  it('names the header of the page when it is the one block of a fold', () => {
    const head = '<header><h1>Lead plan</h1><p>Draft of October 29.</p></header>';
    expect(review('<main>' + head + '<p>We send 20 emails each day.</p></main>', '<main>' + head + '<p>We send 30 emails each day.</p></main>'))
      .toBe('<main><div data-diff-gap="1"><button type="button">The top of the page has no changes</button></div><header data-diff-skip="1"><h1>Lead plan</h1><p>Draft of October 29.</p></header>'
        + '<p data-diff="mod" data-diff-n="1">We send <del data-diff>20</del><ins data-diff>30</ins> emails each day.</p></main>');
  });

  it('names the parts of a block that has no name of its own: the cards of a grid, the table in a frame', () => {
    const cards = '<div class="k-grid"><div class="k-card"><h3>Admin</h3><p>Live.</p></div><div class="k-card"><h3>Menus</h3><p>Live.</p></div><div class="k-card"><h3>Map</h3><p>Live.</p></div></div>';
    const frame = '<div class="k-tframe"><table><tr><th>Service</th></tr><tr><td>AWS</td></tr></table></div>';
    const page = (last: string) => '<main><h1>Status</h1>' + cards + '<p>All three are in the store build.</p><p>' + last + '</p><p>The costs follow.</p>' + frame + '</main>';
    expect(review(page('We check this on Monday.'), page('We check this on Friday.')))
      .toBe('<main><h1>Status</h1>'
        + '<div data-diff-gap="1"><button type="button">3 cards with no changes</button></div>' + cards.replace('<div class="k-grid">', '<div class="k-grid" data-diff-skip="1">')
        + '<p>All three are in the store build.</p><p data-diff="mod" data-diff-n="1">We check this on <del data-diff>Monday</del><ins data-diff>Friday</ins>.</p><p>The costs follow.</p>'
        + '<div data-diff-gap="2"><button type="button">1 table with no changes</button></div>' + frame.replace('<div class="k-tframe">', '<div class="k-tframe" data-diff-skip="2">')
        + '</main>');
  });

  it('folds nothing without the review option', () => {
    expect(marked(page('c5 is old'), page('c5 is new'))).not.toContain('data-diff-gap');
  });

  it('folds the rows of a table with a row, and keeps the head row and the rows next to the change', () => {
    const table = (g: string) => '<table><tr><th>Name</th><th>Cost</th></tr>' + ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((k) => '<tr><td>' + k + '</td><td>' + (k === 'g' ? g : '1') + '</td></tr>').join('') + '</table>';
    expect(review(table('2'), table('3'))).toBe('<table><tr><th>Name</th><th>Cost</th></tr>'
      + '<tr data-diff-gap="1"><td colspan="99"><button type="button">5 rows with no changes</button></td></tr>'
      + ['a', 'b', 'c', 'd', 'e'].map((k) => '<tr data-diff-skip="1"><td>' + k + '</td><td>1</td></tr>').join('')
      + '<tr><td>f</td><td>1</td></tr><tr data-diff-n="1"><td>g</td><td data-diff="mod"><del data-diff>2</del><ins data-diff>3</ins></td></tr><tr><td>h</td><td>1</td></tr></table>');
  });

  it('opens a closed <details> that holds a change', () => {
    expect(review('<details><summary>More</summary><p>Old words.</p></details>', '<details><summary>More</summary><p>New words.</p></details>'))
      .toBe('<details open><summary>More</summary><p data-diff="mod" data-diff-n="1"><del data-diff>Old</del><ins data-diff>New</ins> words.</p></details>');
  });
});

describe('the review of a deck', () => {
  const slide = (id: string, h: string, body: string) => '<section class="k-slide" id="' + id + '"><h2>' + h + '</h2>' + body + '</section>';
  const deck = (slides: string[]) => '<body><main class="k-deck">\n' + slides.join('\n') + '\n</main></body>';
  const same = (n: number, gap: number, html: string) => '<div data-diff-sheet="same" data-diff-skip="' + gap + '"><p data-diff-cap><b>Slide ' + n + '</b></p><div class="k-frame">' + html + '</div></div>';
  const title = slide('title', 'Review', '<p>November 1</p>');
  const pace = slide('pace', 'Pace', '<p>We ship each week.</p>');
  const fixed = slide('fixed', '159 fixes', '<ul><li>Android crashes</li><li>Surprise log-outs after a profile edit</li><li>Slow pages</li></ul>');
  const tools = slide('tools', 'Tools', '<p>Five tools replace two.</p>');
  const next = slide('next', 'Next', '<p>Revenue and growth.</p>');

  it('shows each changed slide as an open sheet with its marks, and lists what the slide lost below it', () => {
    const out = diffHtml(deck([title, pace, fixed, tools, next]), deck([title, pace, slide('fixed', '159 fixes, by area', '<ul><li>Crashes and log-outs</li><li>Slow pages</li></ul>'), tools, next]), { review: true });
    // Without the k-deck class, the deck runtime of the kit does not start.
    expect(out.html).toBe('<body><main class="k-deck-review">\n'
      + '<div data-diff-gap="1"><button type="button">Slides 1 and 2 have no changes</button></div>\n'
      + same(1, 1, title) + '\n' + same(2, 1, pace) + '\n'
      + '<div data-diff-sheet="mod" data-diff-n="1"><p data-diff-cap><b>Slide 3</b> <span>Changed</span></p><div class="k-frame">'
      + '<section class="k-slide" id="fixed"><h2 data-diff="mod">159 fixes<ins data-diff>, by area</ins></h2><ul><li data-diff="add">Crashes and log-outs</li><li>Slow pages</li></ul></section></div>'
      + '<p data-diff-out><b>Removed from this slide</b> <del data-diff>Android crashes</del> <del data-diff>Surprise log-outs after a profile edit</del></p></div>\n'
      + '<div data-diff-gap="2"><button type="button">Slides 4 and 5 have no changes</button></div>\n'
      + same(4, 2, tools) + '\n' + same(5, 2, next) + '\n</main></body>');
    expect(out.deck).toBe(true);
    // The slide is one stop. Each change in it has the number of the slide.
    expect(out.stops).toBe(1);
    expect(out.changes.map((c) => [c.n, c.slide, c.kind, c.noun, c.text])).toEqual([
      [1, 3, 'mod', 'heading', ', by area'],
      [1, 3, 'del', 'item', 'Android crashes'],
      [1, 3, 'del', 'item', 'Surprise log-outs after a profile edit'],
      [1, 3, 'add', 'item', 'Crashes and log-outs'],
    ]);
    expect(summarize(out.changes)).toEqual([{ n: 1, slide: 3, gone: false, heading: '159 fixes, by area', level: 2, what: 'Heading changed, 2 items removed, item added' }]);
  });

  it('shows a new slide, a removed slide and a slide that moved', () => {
    const money = slide('money', 'Money', '<p>We spend less.</p>');
    const out = diffHtml(deck([title, pace, fixed, tools, next]), deck([title, fixed, money, pace, next]), { review: true });
    expect(out.html).toBe('<body><main class="k-deck-review">\n'
      + '<div data-diff-gap="1"><button type="button">Slide 1 has no changes</button></div>\n' + same(1, 1, title) + '\n'
      + '<div data-diff-gap="2"><button type="button">Slide 2 has no changes</button></div>\n' + same(2, 2, fixed) + '\n'
      // A removed slide loses its id, so no id stands in the page two times.
      + '<div data-diff-sheet="del" data-diff-n="1"><p data-diff-cap><b>Slide 4 of the version before</b> <span>Removed</span></p><div class="k-frame"><section class="k-slide"><h2>Tools</h2><p>Five tools replace two.</p></section></div></div>\n'
      + '<div data-diff-sheet="add" data-diff-n="2"><p data-diff-cap><b>Slide 3</b> <span>New</span></p><div class="k-frame">' + money + '</div></div>\n'
      + '<div data-diff-sheet="to" data-diff-n="3"><p data-diff-cap><b>Slide 4</b> <span>Moved from slide 2</span></p><div class="k-frame">' + pace + '</div></div>\n'
      + '<div data-diff-gap="3"><button type="button">Slide 5 has no changes</button></div>\n' + same(5, 3, next) + '\n</main></body>');
    expect(summarize(out.changes)).toEqual([
      { n: 1, slide: 4, gone: true, heading: 'Tools', level: 2, what: 'Slide removed' },
      { n: 2, slide: 3, gone: false, heading: 'Money', level: 2, what: 'New slide' },
      { n: 3, slide: 4, gone: false, heading: 'Pace', level: 2, what: 'Moved from slide 2' },
    ]);
  });

  it('folds nothing inside a slide, because a slide shows as a whole', () => {
    const items = (last: string) => '<ul><li>One</li><li>Two</li><li>Three</li><li>Four</li><li>Five</li><li>Six</li><li>' + last + '</li></ul>';
    const out = diffHtml(deck([title, slide('list', 'Seven items', items('Seven'))]), deck([title, slide('list', 'Seven items', items('Seven, the last one'))]), { review: true });
    expect(out.html).toBe('<body><main class="k-deck-review">\n'
      + '<div data-diff-gap="1"><button type="button">Slide 1 has no changes</button></div>\n' + same(1, 1, title) + '\n'
      + '<div data-diff-sheet="mod" data-diff-n="1"><p data-diff-cap><b>Slide 2</b> <span>Changed</span></p><div class="k-frame">'
      + '<section class="k-slide" id="list"><h2>Seven items</h2><ul><li>One</li><li>Two</li><li>Three</li><li>Four</li><li>Five</li><li>Six</li><li data-diff="mod">Seven<ins data-diff>, the last one</ins></li></ul></section></div></div>\n</main></body>');
  });

  it('marks a deck as a document without the review option', () => {
    const out = diffHtml(deck([title, fixed]), deck([title, slide('fixed', '159 fixes', '<ul><li>Android crashes</li><li>Slow pages</li></ul>')]));
    expect(out.html).toBe('<body><main class="k-deck">\n' + title + '\n<section class="k-slide" id="fixed"><h2>159 fixes</h2><ul><li>Android crashes</li><li data-diff="del" data-diff-n="1">Surprise log-outs after a profile edit</li><li>Slow pages</li></ul></section>\n</main></body>');
  });
});

describe('the list of places', () => {
  it('gives one line for each heading, with what changed below it', () => {
    const before = '<h2>Sources</h2><p>Apollo is not tested.</p><table><tr><td>Apollo</td><td>none</td><td>none</td></tr></table><h2>Decisions</h2><ul><li>Spend two dollars.</li><li>Get a key.</li></ul>';
    const after = '<h2>Sources</h2><p>Apollo is tested.</p><table><tr><td>Apollo</td><td>88%</td><td>41%</td></tr></table><h2>Three decisions</h2><ul><li>Spend thirty cents.</li></ul>';
    expect(summarize(diffHtml(before, after).changes)).toEqual([
      { n: 1, slide: 0, gone: false, heading: 'Sources', level: 2, what: 'Paragraph and 2 cells changed' },
      { n: 3, slide: 0, gone: false, heading: 'Three decisions', level: 2, what: 'Heading and item changed, item removed' },
    ]);
  });

  it('gives no line for two equal versions', () => {
    expect(summarize(diffHtml('<p>Same.</p>', '<p>Same.</p>').changes)).toEqual([]);
  });
});
