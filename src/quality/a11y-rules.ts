/**
 * Plain-language explanations for the most common axe-core rules: who is affected and
 * how to fix it. Rules not listed here fall back to axe's own help text.
 */
export interface RuleExplanation {
    /** Short name of the problem. */
    title: string;
    /** Who is affected and how. */
    who: string;
    /** What to change. */
    fix: string;
}

export const RULE_EXPLANATIONS: Record<string, RuleExplanation> = {
    'color-contrast': {
        title: 'Text is hard to read against its background',
        who: 'People with low vision or colour blindness, and anyone reading on a phone in sunlight, cannot read low-contrast text.',
        fix: 'Darken the text or lighten the background until the contrast ratio is at least 4.5:1 (3:1 for large text). A contrast checker in the browser dev tools shows the ratio.'
    },
    'color-contrast-enhanced': {
        title: 'Text contrast is below the stricter AAA level',
        who: 'People with moderate low vision need stronger contrast than the AA minimum.',
        fix: 'Raise the contrast ratio to 7:1 (4.5:1 for large text) where you can.'
    },
    'image-alt': {
        title: 'Image has no text alternative',
        who: 'Blind people using a screen reader hear nothing, or a meaningless file name, instead of what the image shows.',
        fix: 'Add an alt attribute that says what the image means (alt="Red running shoes"). Use alt="" for purely decorative images.'
    },
    'input-image-alt': {
        title: 'Image button has no text alternative',
        who: 'Screen reader users cannot tell what the image button does.',
        fix: 'Give the <input type="image"> an alt attribute that names the action, such as alt="Search".'
    },
    'role-img-alt': {
        title: 'Element shown as an image has no text alternative',
        who: 'Screen reader users get no description of the image.',
        fix: 'Add aria-label or aria-labelledby to the element with role="img".'
    },
    'svg-img-alt': {
        title: 'SVG image has no text alternative',
        who: 'Screen reader users get no description of the icon or chart.',
        fix: 'Add a <title> inside the SVG or aria-label on it; hide decorative SVGs with aria-hidden="true".'
    },
    label: {
        title: 'Form field has no label',
        who: 'Screen reader users do not know what to type, and voice-control users cannot say the field name to move to it.',
        fix: 'Connect a visible <label for="id"> to the field, or wrap the field in the label. A placeholder alone is not a label.'
    },
    'label-title-only': {
        title: 'Form field is labelled only by a tooltip',
        who: 'The title tooltip is invisible to keyboard and touch users and is read inconsistently by screen readers.',
        fix: 'Add a visible <label> for the field.'
    },
    'button-name': {
        title: 'Button has no name',
        who: 'Screen reader users hear only "button" and cannot tell what it does; voice-control users cannot activate it by name.',
        fix: 'Put text inside the button, or add aria-label (for icon buttons, e.g. aria-label="Close").'
    },
    'input-button-name': {
        title: 'Input button has no name',
        who: 'Screen reader users hear only "button".',
        fix: 'Give <input type="submit|button|reset"> a value attribute such as value="Send".'
    },
    'link-name': {
        title: 'Link has no name',
        who: 'Screen reader users hear only "link" and cannot tell where it goes.',
        fix: 'Put text inside the link, or give an icon link an aria-label. Avoid empty links.'
    },
    'html-has-lang': {
        title: 'Page language is not set',
        who: 'Screen readers guess the language and may read the page with the wrong pronunciation; translation tools work less well.',
        fix: 'Add the language to the html element, for example <html lang="en">.'
    },
    'html-lang-valid': {
        title: 'Page language code is not valid',
        who: 'Screen readers cannot pick the right voice and pronunciation.',
        fix: 'Use a valid language code such as lang="en", "en-GB", "de" or "fr".'
    },
    'valid-lang': {
        title: 'A language code on the page is not valid',
        who: 'Screen readers read that part with the wrong pronunciation.',
        fix: 'Fix the lang attribute on the element to a valid code such as "es" or "fr".'
    },
    'document-title': {
        title: 'Page has no title',
        who: 'Screen reader users and people with many tabs open cannot tell which page they are on.',
        fix: 'Add a short, unique <title> to each page, such as "Basket - Demo Shop".'
    },
    'landmark-one-main': {
        title: 'Page has no main area',
        who: 'Screen reader and keyboard users cannot jump straight to the main content and must go through menus first.',
        fix: 'Wrap the page\'s main content in a <main> element (one per page).'
    },
    region: {
        title: 'Some content is outside any page area',
        who: 'Screen reader users who move by landmarks (header, navigation, main, footer) can miss this content.',
        fix: 'Put all visible content inside landmarks: <header>, <nav>, <main>, <footer> (or <aside>).'
    },
    'landmark-unique': {
        title: 'Two page areas have the same name',
        who: 'Screen reader users cannot tell similar areas apart (for example two navigation menus).',
        fix: 'Give repeated landmarks distinct names with aria-label, such as aria-label="Main menu" and aria-label="Footer links".'
    },
    'landmark-no-duplicate-banner': {
        title: 'Page has more than one header area',
        who: 'Screen reader users find several "banner" areas and cannot tell which is the page header.',
        fix: 'Keep one top-level <header>; headers inside <article> or <section> are fine.'
    },
    'landmark-no-duplicate-contentinfo': {
        title: 'Page has more than one footer area',
        who: 'Screen reader users find several page footers.',
        fix: 'Keep one top-level <footer> for the page.'
    },
    'landmark-complementary-is-top-level': {
        title: 'A sidebar area is nested inside another area',
        who: 'Screen reader users get a confusing page structure.',
        fix: 'Move the <aside> so it is not inside another landmark.'
    },
    'page-has-heading-one': {
        title: 'Page has no main heading',
        who: 'Screen reader users often jump to the first-level heading to find what the page is about.',
        fix: 'Add one <h1> that names the page.'
    },
    'heading-order': {
        title: 'Heading levels skip a step',
        who: 'Screen reader users navigate by headings and may think content is missing when levels jump (h2 to h4).',
        fix: 'Use heading levels in order (h1, then h2, then h3). Change the look with CSS, not the level.'
    },
    'empty-heading': {
        title: 'Heading is empty',
        who: 'Screen reader users hear a heading with no text, which is confusing when moving by headings.',
        fix: 'Put text in the heading or remove it.'
    },
    'duplicate-id-aria': {
        title: 'Two elements share an id used for labels or descriptions',
        who: 'Screen readers may read the wrong label or description for a field.',
        fix: 'Make every id unique on the page, especially ids referenced by for, aria-labelledby or aria-describedby.'
    },
    'duplicate-id-active': {
        title: 'Two focusable elements share the same id',
        who: 'Assistive technology may focus or announce the wrong element.',
        fix: 'Give every focusable element a unique id.'
    },
    'duplicate-id': {
        title: 'Two elements share the same id',
        who: 'Labels and scripts may point at the wrong element, which can confuse assistive technology.',
        fix: 'Make every id unique on the page.'
    },
    'aria-allowed-attr': {
        title: 'ARIA attribute is not allowed on this element',
        who: 'Screen readers may ignore or misreport the element\'s state.',
        fix: 'Remove the attribute, or change the role to one that supports it (see the ARIA specification).'
    },
    'aria-required-attr': {
        title: 'Element is missing a required ARIA attribute',
        who: 'Screen readers cannot report the element\'s state (for example whether a checkbox is ticked).',
        fix: 'Add the required attribute for the role, such as aria-checked for role="checkbox" or aria-level for role="heading".'
    },
    'aria-required-children': {
        title: 'ARIA container is missing its required items',
        who: 'Screen readers cannot announce the list, menu or tabs correctly.',
        fix: 'Give the container the child roles it needs (role="list" needs role="listitem" children, role="tablist" needs role="tab").'
    },
    'aria-required-parent': {
        title: 'ARIA item is outside its required container',
        who: 'Screen readers announce the item without its context (for example a tab without its tab list).',
        fix: 'Place the element inside a parent with the right role, such as role="tab" inside role="tablist".'
    },
    'aria-roles': {
        title: 'ARIA role is not valid',
        who: 'Screen readers ignore the role, so the element is announced wrongly or not at all.',
        fix: 'Use a valid role name, or better, the matching HTML element (<button>, <nav>, <dialog>).'
    },
    'aria-valid-attr': {
        title: 'ARIA attribute name is misspelled',
        who: 'Screen readers ignore the attribute.',
        fix: 'Correct the spelling (for example aria-labelledby, not aria-labeledby).'
    },
    'aria-valid-attr-value': {
        title: 'ARIA attribute has an invalid value',
        who: 'Screen readers may announce the wrong state or a broken reference.',
        fix: 'Use an allowed value (true/false, or the id of an existing element for references).'
    },
    'aria-hidden-focus': {
        title: 'Hidden content can still receive keyboard focus',
        who: 'Keyboard and screen reader users land on something that is announced as nothing.',
        fix: 'Remove aria-hidden from focusable content, or make it unfocusable (tabindex="-1", or the inert attribute).'
    },
    'aria-hidden-body': {
        title: 'The whole page is hidden from screen readers',
        who: 'Screen reader users cannot read the page at all.',
        fix: 'Remove aria-hidden="true" from the body element.'
    },
    'aria-command-name': {
        title: 'ARIA button, link or menu item has no name',
        who: 'Screen reader users hear only the role and cannot tell what it does.',
        fix: 'Add text content or aria-label.'
    },
    'aria-input-field-name': {
        title: 'ARIA input field has no name',
        who: 'Screen reader users do not know what to type.',
        fix: 'Add aria-label or aria-labelledby pointing at visible text.'
    },
    'aria-toggle-field-name': {
        title: 'ARIA switch or checkbox has no name',
        who: 'Screen reader users cannot tell what the switch controls.',
        fix: 'Add text content, aria-label or aria-labelledby.'
    },
    'aria-dialog-name': {
        title: 'Dialog has no name',
        who: 'Screen reader users are not told what the dialog is about when it opens.',
        fix: 'Add aria-labelledby pointing at the dialog\'s heading, or aria-label.'
    },
    'aria-progressbar-name': {
        title: 'Progress bar has no name',
        who: 'Screen reader users hear progress without knowing what it measures.',
        fix: 'Add aria-label or aria-labelledby.'
    },
    'aria-tooltip-name': {
        title: 'Tooltip has no text',
        who: 'Screen reader users get an empty tooltip.',
        fix: 'Put text in the tooltip or label it with aria-label.'
    },
    'aria-prohibited-attr': {
        title: 'ARIA attribute is not allowed for this role',
        who: 'Screen readers may ignore the label, so the element is announced without a name.',
        fix: 'Remove the attribute or use visible text instead (aria-label is not allowed on plain div and span).'
    },
    'nested-interactive': {
        title: 'Interactive element inside another interactive element',
        who: 'Screen readers and keyboards cannot reach or announce the inner control properly.',
        fix: 'Do not put buttons or links inside other buttons or links; place them side by side.'
    },
    'frame-title': {
        title: 'Frame has no title',
        who: 'Screen reader users cannot tell what an embedded frame (map, video, ad) contains before entering it.',
        fix: 'Add a title attribute to the iframe, such as title="Store location map".'
    },
    'frame-title-unique': {
        title: 'Two frames have the same title',
        who: 'Screen reader users cannot tell the frames apart.',
        fix: 'Give each iframe a distinct title.'
    },
    list: {
        title: 'List contains items that are not list items',
        who: 'Screen readers announce the wrong number of items or break the list up.',
        fix: 'Only put <li> elements (or <script>/<template>) directly inside <ul> and <ol>.'
    },
    listitem: {
        title: 'List item is outside a list',
        who: 'Screen readers do not announce it as part of a list.',
        fix: 'Put every <li> inside a <ul> or <ol>.'
    },
    'definition-list': {
        title: 'Definition list is built incorrectly',
        who: 'Screen readers cannot pair terms with their descriptions.',
        fix: 'Only put <dt>, <dd> (optionally grouped in <div>) inside <dl>.'
    },
    dlitem: {
        title: 'Term or description is outside a definition list',
        who: 'Screen readers do not announce the term and its description together.',
        fix: 'Put <dt> and <dd> inside a <dl>.'
    },
    'meta-viewport': {
        title: 'Zooming is disabled',
        who: 'People with low vision cannot pinch to zoom on phones.',
        fix: 'Remove user-scalable=no and maximum-scale=1 from the viewport meta tag.'
    },
    'meta-viewport-large': {
        title: 'Zoom is limited',
        who: 'People with low vision cannot zoom in far enough.',
        fix: 'Allow zoom to at least 500% (maximum-scale of 5 or more, or leave it out).'
    },
    'meta-refresh': {
        title: 'Page refreshes or redirects on a timer',
        who: 'People who read slowly or use screen readers lose their place when the page reloads.',
        fix: 'Remove the timed meta refresh, or let users control it.'
    },
    'select-name': {
        title: 'Dropdown has no label',
        who: 'Screen reader users do not know what the dropdown is for.',
        fix: 'Connect a visible <label for="id"> to the <select>.'
    },
    'autocomplete-valid': {
        title: 'Autocomplete value is not valid',
        who: 'Browsers and password managers cannot fill the field, which matters most for people with motor or memory difficulties.',
        fix: 'Use a standard token such as autocomplete="email", "given-name", "current-password" or "street-address".'
    },
    'target-size': {
        title: 'Touch target is too small',
        who: 'People with tremors or limited dexterity, and everyone on a phone, miss small buttons and tap the wrong thing.',
        fix: 'Make clickable targets at least 24 by 24 CSS pixels, or leave enough space around them.'
    },
    tabindex: {
        title: 'Positive tabindex changes the keyboard order',
        who: 'Keyboard users jump around the page in an unexpected order.',
        fix: 'Use tabindex="0" or "-1" only, and order the HTML so the natural order is right.'
    },
    'bypass': {
        title: 'No way to skip repeated content',
        who: 'Keyboard users must tab through the whole menu on every page.',
        fix: 'Add a "Skip to main content" link at the top, or use landmarks such as <main>.'
    },
    'scrollable-region-focusable': {
        title: 'Scrollable area cannot be reached by keyboard',
        who: 'Keyboard users cannot scroll to the hidden content.',
        fix: 'Add tabindex="0" to the scrollable container (and a label), or put a focusable element inside it.'
    },
    'link-in-text-block': {
        title: 'Link is only distinguishable by colour',
        who: 'Colour-blind people cannot see which words are links.',
        fix: 'Underline links in text, or give them a 3:1 contrast with the text plus a hover/focus style.'
    },
    'video-caption': {
        title: 'Video has no captions',
        who: 'Deaf and hard-of-hearing people miss everything that is said.',
        fix: 'Add a captions track (<track kind="captions">) to the video.'
    },
    'object-alt': {
        title: 'Embedded object has no text alternative',
        who: 'Screen reader users get no description of the embedded content.',
        fix: 'Add text inside the <object> element, or aria-label.'
    },
    'area-alt': {
        title: 'Image map area has no text alternative',
        who: 'Screen reader users cannot tell where each clickable area leads.',
        fix: 'Add an alt attribute to every <area>.'
    },
    'empty-table-header': {
        title: 'Table header is empty',
        who: 'Screen reader users hear an empty column name when reading table cells.',
        fix: 'Put text in every <th>, or use <td> for empty corner cells.'
    },
    'td-headers-attr': {
        title: 'Table cell points at headers that do not exist',
        who: 'Screen reader users hear the wrong column or row name.',
        fix: 'Fix the headers attribute so it lists ids of <th> cells in the same table.'
    },
    'th-has-data-cells': {
        title: 'Table header has no data cells',
        who: 'Screen reader users get a confusing table structure.',
        fix: 'Make sure each <th> describes real data cells, or use <td>.'
    },
    'server-side-image-map': {
        title: 'Server-side image map',
        who: 'Keyboard and screen reader users cannot use server-side image maps.',
        fix: 'Replace it with normal links or a client-side image map with alt text.'
    },
    blink: {
        title: 'Blinking content',
        who: 'Blinking text distracts people with attention or vestibular disorders and is hard to read.',
        fix: 'Remove <blink> and blinking animations.'
    },
    marquee: {
        title: 'Moving text',
        who: 'Scrolling text is hard to read for people with low vision or reading difficulties.',
        fix: 'Remove <marquee>; show the content statically.'
    }
};

export function explainRule(id: string, fallback: { help?: string; description?: string }): RuleExplanation & { builtIn: boolean } {
    const known = RULE_EXPLANATIONS[id];
    if (known) return { ...known, builtIn: true };
    return { title: fallback.help ?? id, who: fallback.description ?? 'Some people using assistive technology may be affected.', fix: 'Follow the rule\'s help page for the exact fix.', builtIn: false };
}
