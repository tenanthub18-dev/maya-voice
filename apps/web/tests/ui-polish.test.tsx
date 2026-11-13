// @vitest-environment jsdom

import {cleanup, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it} from 'vitest';
import {Select, Tab, Tabs} from '@/components/ui';

afterEach(cleanup);

describe('mobile navigation and form polish', () => {
  it('keeps tabs on one horizontally scrollable snap row with an edge fade', () => {
    render(<Tabs label="Agent sections"><Tab href="/agent?tab=persona" active>Voice</Tab><Tab href="/agent?tab=knowledge" active={false}>Knowledge</Tab></Tabs>);

    const tabs = screen.getByRole('navigation', {name: 'Agent sections'});
    expect(tabs.className).toContain('overflow-x-auto');
    expect(tabs.className).toContain('whitespace-nowrap');
    expect(tabs.className).toContain('snap-x');
    expect(tabs.parentElement?.getAttribute('data-scroll-fade')).toBe('end');
    expect(screen.getByRole('link', {name: 'Voice'}).className).toContain('snap-start');
  });

  it('renders a labelled 44px select with native appearance removed and a decorative chevron', () => {
    const {container} = render(<Select label="Language" name="language"><option>English</option></Select>);

    const select = screen.getByRole('combobox', {name: 'Language'});
    expect(select.className).toContain('min-h-11');
    expect(select.className).toContain('appearance-none');
    expect(select.className).toContain('pr-10');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
