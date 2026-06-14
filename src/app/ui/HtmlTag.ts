import { escapeHtml } from '../htmlEscape';

type Value = any;

function htmlValue(value: Value): string {
    if (value instanceof HTMLTemplateElement) {
        return value.innerHTML;
    }
    if (typeof value === 'undefined') {
        return 'undefined';
    }
    if (value === null) {
        return 'null';
    }
    // Escape for both text and attribute context (quotes included) so an
    // interpolated value cannot break out of an attribute and inject markup or
    // an event handler. (The previous innerText round-trip did not escape
    // quotes, leaving attribute interpolation injectable.)
    return escapeHtml(value.toString());
}

export const html = function html(strings: TemplateStringsArray, ...values: ReadonlyArray<Value>): HTMLTemplateElement {
    const template = document.createElement('template') as HTMLTemplateElement;
    template.innerHTML = values.reduce((acc, v, idx) => acc + htmlValue(v) + strings[idx + 1], strings[0]).toString();
    return template;
};
