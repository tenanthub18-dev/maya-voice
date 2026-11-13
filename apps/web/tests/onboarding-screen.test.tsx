// @vitest-environment jsdom

import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import messages from '@/messages/en.json';
import messagesFr from '@/messages/fr.json';
import {OnboardingWizard, type WizardSavePayload} from '@/components/onboarding-screen';
import {getMockSeed} from '@/lib/data/mock';
import type {OnboardingStep} from '@/lib/data/types';

const push = vi.fn();

vi.mock('next/navigation', () => ({useRouter: () => ({push})}));

function renderStepOne(saveStep = vi.fn().mockResolvedValue(undefined)) {
  return renderWizard(1, {saveStep}).saveStep;
}

function renderWizard(step: OnboardingStep, options: {saveStep?: (payload: WizardSavePayload) => Promise<void>; locale?: 'en' | 'fr'} = {}) {
  const seed = getMockSeed();
  const saveStep = options.saveStep ?? vi.fn().mockResolvedValue(undefined);
  const locale = options.locale ?? 'en';
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'fr' ? messagesFr : messages}>
      <OnboardingWizard
        step={step}
        state={seed.onboardingState}
        restaurant={seed.restaurant}
        hours={seed.hours}
        menuItems={seed.menuItems}
        faqs={seed.faqs}
        agent={seed.agent}
        slots={seed.slotsConfig}
        saveStep={saveStep}
        initialPhone={null}
      />
    </NextIntlClientProvider>
  );
  return {saveStep};
}

describe('onboarding wizard navigation and validation', () => {
  beforeEach(() => push.mockReset());
  afterEach(cleanup);

  it('blocks step one until the required restaurant fields are filled', async () => {
    const saveStep = renderStepOne();
    fireEvent.change(screen.getByLabelText('Restaurant name'), {target: {value: ''}});
    fireEvent.submit(screen.getByRole('form', {name: 'Restaurant basics'}));

    expect((await screen.findByRole('alert')).textContent).toBe('Enter your restaurant name and address.');
    expect(saveStep).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('persists step one and navigates to website import', async () => {
    const saveStep = renderStepOne();
    fireEvent.change(screen.getByLabelText('Website URL'), {target: {value: 'https://harbourtable.example'}});
    fireEvent.change(screen.getByLabelText('Cuisine'), {target: {value: 'South Asian'}});
    fireEvent.submit(screen.getByRole('form', {name: 'Restaurant basics'}));

    await waitFor(() => expect(saveStep).toHaveBeenCalledWith(expect.objectContaining({
      completedStep: 1,
      basics: expect.objectContaining({websiteUrl: 'https://harbourtable.example', cuisine: 'South Asian'})
    })));
    expect(push).toHaveBeenCalledWith('/onboarding/2');
  });

  it('completes steps three through six at a 375px viewport', async () => {
    Object.defineProperty(window, 'innerWidth', {configurable: true, value: 375});
    const forms = ['Knowledge review', 'Voice and languages', 'Restaurant rules', 'Test call'];
    for (let step = 3; step <= 6; step += 1) {
      const {saveStep} = renderWizard(step as OnboardingStep);
      fireEvent.submit(screen.getByRole('form', {name: forms[step - 3]}));
      await waitFor(() => expect(saveStep).toHaveBeenCalledWith(expect.objectContaining({completedStep: step})));
      expect(push).toHaveBeenCalledWith(`/onboarding/${step + 1}`);
      cleanup();
      push.mockReset();
    }
  });

  it('enables the number search controls on the final step', () => {
    renderWizard(7);

    expect(screen.getByText('Pricing will be shared before launch')).toBeTruthy();
    expect(screen.queryByText(/more included minutes|14-day|60-minute trial/i)).toBeNull();
    expect(screen.getByRole('button', {name: 'Continue to secure checkout'}).hasAttribute('disabled')).toBe(false);
    expect((screen.getByLabelText('Canadian area code') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole('button', {name: 'Search numbers'})).toBeTruthy();
  });

  it('renders the wizard in French', () => {
    renderWizard(1, {locale: 'fr'});
    expect(screen.getByRole('heading', {level: 1}).textContent).toBe('Présentez votre restaurant');
    expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe('Progression de la configuration');
  });
});
