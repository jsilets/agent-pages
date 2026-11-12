// The pages that the browser tests publish. Each page has the markers of the packed kit, so the host swaps in the
// current kit/explain.css and kit/explain.js when it serves the page.
const KIT = '<style>\n/* explain.css */\n</style>';
const JS = '<script>\n/* explain.js */\n</script>';

const para = (n) => `<p>Paragraph ${n}. A heat pump moves heat from one place to another place. It uses a small amount of energy to move a large amount of heat, so it costs less to run than a boiler in most homes.</p>`;

/** A long document: inline elements, two paragraphs, a list, a table, a code block, a flow diagram and an anchor link. */
export const docPage = (title = 'Browser test page') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${KIT}</head>
<body><main class="k-page">
<header><h1>How a heat pump heats a house</h1><p class="k-stamp">tests · browser</p>
<p class="k-lede">A heat pump moves heat <b>from the outside air</b> into the house. It uses about <em>one third</em> of the energy of a gas boiler.</p></header>
<p><a href="#costs">Go to the costs</a></p>
<section class="k-claim" id="basics"><h2>The basics of the cycle</h2>
<p id="p-first">The first paragraph has <b>bold words</b>, <a href="#costs">a link</a> and <code>inline code</code> in the same sentence, so a selection crosses three inline elements.</p>
<p id="p-second">The second paragraph follows it. A selection can start in the first paragraph and end here in the second one.</p>
<ul id="list"><li>Insulate the roof first.</li><li>Seal the gaps around the windows.</li><li>Fit the heat pump last.</li></ul>
</section>
<section class="k-claim" id="costs"><h2>What it costs</h2>
<table class="k-table" id="table"><thead><tr><th>Part</th><th class="num">Cost</th></tr></thead>
<tbody><tr><td>Outdoor unit</td><td class="num">4,200</td></tr><tr><td>Hot water tank</td><td class="num">1,100</td></tr></tbody></table>
<pre id="code"><code>cost = unit + tank
grant = 0.5 * cost</code></pre>
${[1, 2, 3, 4].map(para).join('\n')}
</section>
<section class="k-claim" id="flow"><h2>The flow of heat</h2>
<figure><div class="k-flow"><script type="text/plain">
air = Outside air
pump = Heat pump
house = House
air -> pump : heat
pump -> house : warm water
</script></div><figcaption>The heat goes from the air to the house.</figcaption></figure>
${[5, 6, 7, 8, 9, 10].map(para).join('\n')}
<p id="p-last">The last paragraph of the page ends the document.</p>
</section>
</main>${JS}</body></html>`;

/** A deck of four slides. Slide 2 has a list, and slide 3 has a table. */
export const deckPage = (title = 'Browser test deck') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${KIT}</head>
<body><main class="k-deck">
<section class="k-claim k-slide" data-layout="title" id="s-title"><h1>Heat pumps in one deck</h1><p class="k-lede">Four slides for the browser tests.</p></section>
<section class="k-claim k-slide" data-layout="bullets" id="s-why"><h2>Why a heat pump</h2><ul><li>It moves heat, it does not make heat.</li><li>It costs less to run than a boiler.</li><li>It works in cold weather too.</li></ul></section>
<section class="k-claim k-slide" data-layout="table" id="s-cost"><h2>What it costs</h2><table class="k-table"><tr><th>Part</th><th>Cost</th></tr><tr><td>Unit</td><td>4,200</td></tr><tr><td>Tank</td><td>1,100</td></tr></table></section>
<section class="k-claim k-slide" data-layout="statement" id="s-end"><h2>Insulate first, then fit the pump.</h2></section>
</main>${JS}</body></html>`;
