/**
 * Remove every `<title>` child from an SVG element. Iterates a static snapshot
 * (`querySelectorAll`) rather than the live `getElementsByTagName` collection:
 * removing from a live collection while indexing it shifts the remaining entries
 * down, so a plain index loop skips elements. (#92)
 */
export function removeSvgTitles(svg: Element): void {
    for (const title of svg.querySelectorAll('title')) {
        title.remove();
    }
}
