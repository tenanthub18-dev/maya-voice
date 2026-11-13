// @vitest-environment jsdom
import {cleanup, render, screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach, describe, expect, it} from 'vitest';

import {AuthPanel} from '@/components/auth-panel';
import {LandingPageContent} from '@/components/landing-page';
import messages from '@/messages/en.json';

function renderLocalized(children: React.ReactNode) {
  return render(<NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider>);
}

afterEach(cleanup);

describe('authentication UI', () => {
  it('makes one-click owner login prominent in mock mode while retaining live forms below', () => {
    renderLocalized(<AuthPanel mode="login" mock />);

    const demoButton = screen.getByRole('button', {name: 'Log in'});
    expect(demoButton.getAttribute('name')).toBe('intent');
    expect(demoButton.getAttribute('value')).toBe('demo');
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('button', {name: /continue with google/i})).toBeTruthy();
    expect(screen.getByRole('button', {name: /email me a magic link/i})).toBeTruthy();
  });

  it('never renders the one-click demo action in live mode', () => {
    renderLocalized(<AuthPanel mode="login" mock={false} />);

    expect(screen.getByRole('button', {name: /^Log in$/u}).getAttribute('value')).toBe('password');
    expect(screen.queryByText(/demo owner/i)).toBeNull();
  });

  it('announces a friendly callback failure without hiding the login form', () => {
    renderLocalized(<AuthPanel mode="login" mock={false} errorMessage="Your sign-in link could not be completed. Please try again." />);

    expect(screen.getByRole('alert').textContent)
      .toBe('Your sign-in link could not be completed. Please try again.');
    expect(screen.getByRole('button', {name: /^Log in$/u})).toBeTruthy();
  });
});

describe('landing page', () => {
  it('shows the product promise, launch languages, undecided pricing, and coming-soon phone placeholder', () => {
    renderLocalized(<LandingPageContent mock />);

    expect(screen.getByRole('heading', {name: /restaurant calls, answered while your team serves/i})).toBeTruthy();
    expect(screen.getByText('English')).toBeTruthy();
    expect(screen.getByText('Français canadien')).toBeTruthy();
    expect(screen.getByText('اردو')).toBeTruthy();
    expect(screen.getByText('हिन्दी')).toBeTruthy();
    expect(screen.getByText('ਪੰਜਾਬੀ')).toBeTruthy();
    expect(screen.getByText(/demo line not connected yet/i)).toBeTruthy();
    expect(screen.getByText('Pricing will be shared before launch')).toBeTruthy();
    expect(screen.queryByText(/\$69 CAD|14-day|60-minute trial/i)).toBeNull();
    expect(screen.getAllByRole('button', {name: 'Log in'})[0]?.getAttribute('value')).toBe('demo');
    expect(screen.getAllByRole('link', {name: 'Sign up'})[0]?.getAttribute('href')).toBe('/signup');
  });
});
