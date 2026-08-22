import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, safePluginReadmeHref } from './markdown';

function renderPluginReadme(source: string): string {
  return renderToStaticMarkup(createElement(Markdown, { pluginReadme: true, children: source }));
}

describe('plugin README markdown', () => {
  it('accepts only absolute HTTP(S) destinations', () => {
    expect(safePluginReadmeHref('https://example.com/docs')).toBe('https://example.com/docs');
    expect(safePluginReadmeHref('HTTP://example.com')).toBe('http://example.com/');
    expect(safePluginReadmeHref('/relative')).toBeNull();
    expect(safePluginReadmeHref('javascript:alert(1)')).toBeNull();
    expect(safePluginReadmeHref('data:text/html,hello')).toBeNull();
  });

  it('keeps GFM content while allowing only external HTTP(S) links', () => {
    const html = renderPluginReadme(
      [
        '| 功能 | 状态 |',
        '| --- | --- |',
        '| 预览 | ✅ |',
        '',
        '[官网](https://example.com) [危险链接](javascript:alert(1))',
      ].join('\n')
    );

    expect(html).toContain('<table');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('javascript:');
  });

  it('drops raw HTML and replaces images with a non-loading placeholder', () => {
    const html = renderPluginReadme(
      [
        '<script>globalThis.compromised = true</script>',
        '<div>raw html</div>',
        '![远程图](https://example.com/tracker.png)',
      ].join('\n\n')
    );

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<div>raw html</div>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('tracker.png');
    expect(html).toContain('[图片未显示：远程图]');
  });
});
