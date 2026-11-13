// @vitest-environment jsdom

import {cleanup, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it} from 'vitest';

import {OperationalBanners} from '@/components/operational-banners';

afterEach(cleanup);

describe('operational banners', () => {
  it('announces blocking states as alerts and grace states as status', () => {
    render(<OperationalBanners notices={[
      {id: 'paused', tone: 'danger', title: 'Agent paused', body: 'Calls are forwarded.'},
      {id: 'grace', tone: 'warning', title: 'Payment failed', body: 'Grace period active.'},
    ]}/>);

    expect(screen.getByRole('alert').textContent).toContain('Agent paused');
    expect(screen.getByRole('status').textContent).toContain('Payment failed');
  });
});
