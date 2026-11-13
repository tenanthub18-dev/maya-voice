// @vitest-environment jsdom

import React from 'react';
import {execFileSync} from 'node:child_process';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import messages from '@/messages/en.json';
import {ModalShell} from '@/components/modal-shell';
import {NumberLifecycleFlow} from '@/components/onboarding-number-flow';
import {TeachDrawer} from '@/components/teach-drawer';

const push = vi.fn();

vi.mock('next/navigation', () => ({useRouter: () => ({push})}));
vi.mock('@/app/calls/[id]/actions', () => ({saveTeaching: vi.fn().mockResolvedValue(false)}));

function provider(children: React.ReactNode) {
  return render(<NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider>);
}

beforeEach(() => {
  push.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(cleanup);

describe('dialog keyboard and focus management', () => {
  it('traps focus in ModalShell, closes with Escape, and restores focus on unmount', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const view = render(
      <ModalShell closeLabel="Close" labelledBy="dialog-title" closeHref="/calls">
        <h2 id="dialog-title">Details</h2><button>First</button><button>Last</button>
      </ModalShell>,
    );

    const first = screen.getByRole('button', {name: 'First'});
    const last = screen.getByRole('button', {name: 'Last'});
    expect(document.activeElement).toBe(first);
    last.focus();
    fireEvent.keyDown(document, {key: 'Tab'});
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, {key: 'Tab', shiftKey: true});
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, {key: 'Escape'});
    expect(push).toHaveBeenCalledWith('/calls');
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('names TeachDrawer, focuses its field, traps Tab, and restores the trigger after Escape', () => {
    render(<TeachDrawer callId="call-1" question="What time?" language="en" labels={{
      open: 'Teach', title: 'Teach the agent', description: 'Save a better answer', field: 'Answer',
      save: 'Save', saving: 'Saving', cancel: 'Cancel', close: 'Close',
    }}/>);

    const trigger = screen.getByRole('button', {name: 'Teach'});
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', {name: 'Teach the agent'});
    const field = screen.getByRole('textbox', {name: 'Answer'});
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(field);
    const close = screen.getByRole('button', {name: 'Close'});
    close.focus();
    fireEvent.keyDown(document, {key: 'Tab', shiftKey: true});
    expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Save'}));
    fireEvent.keyDown(document, {key: 'Escape'});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('traps the release confirmation, closes with Escape, and restores its trigger', () => {
    provider(<NumberLifecycleFlow restaurantId="restaurant-1" initialPhone={{
      id: 'phone-1', e164: '+14165550123', forwardingVerifiedAt: null,
    }}/>);

    const trigger = screen.getByRole('button', {name: 'Release number'});
    fireEvent.click(trigger);
    const field = screen.getByRole('textbox', {name: 'Reason for release'});
    expect(document.activeElement).toBe(field);
    field.focus();
    fireEvent.keyDown(document, {key: 'Tab', shiftKey: true});
    expect(document.activeElement).toBe(screen.getByRole('button', {name: 'Cancel'}));
    fireEvent.keyDown(document, {key: 'Escape'});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('automated accessibility checks', () => {
  it('has no axe violations in the number lifecycle flow', async () => {
    // axe-core result contract: https://github.com/dequelabs/axe-core/blob/develop/doc/API.md#results-object
    const {default: axe} = await import('axe-core');
    const view = provider(<NumberLifecycleFlow restaurantId="restaurant-1" initialPhone={null}/>);
    const results = await axe.run(view.container, {rules: {'color-contrast': {enabled: false}}});
    expect(results.violations.map(({id}) => id)).toEqual([]);
  });

  it('has no axe violations in the open teaching drawer', async () => {
    const {default: axe} = await import('axe-core');
    const view = render(<TeachDrawer callId="call-2" question="Is parking available?" language="en" labels={{
      open: 'Teach', title: 'Teach the agent', description: 'Save a better answer', field: 'Answer',
      save: 'Save', saving: 'Saving', cancel: 'Cancel', close: 'Close',
    }}/>);
    fireEvent.click(screen.getByRole('button', {name: 'Teach'}));
    const results = await axe.run(view.container, {rules: {'color-contrast': {enabled: false}}});
    expect(results.violations.map(({id}) => id)).toEqual([]);
  });
});

describe('theme token contrast', () => {
  it('passes the executable WCAG AA contrast audit for light and dark themes', () => {
    expect(() => execFileSync(process.execPath, ['scripts/check-contrast.mjs'], {cwd: process.cwd(), stdio: 'pipe'})).not.toThrow();
  });
});
