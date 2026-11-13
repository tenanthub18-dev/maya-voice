export const navigationItems = [
  {href: '/home', key: 'home'},
  {href: '/calls', key: 'calls'},
  {href: '/bookings', key: 'bookings'},
  {href: '/orders', key: 'orders'},
  {href: '/agent', key: 'agent'},
  {href: '/phone', key: 'phone'},
  {href: '/analytics', key: 'analytics'},
  {href: '/settings', key: 'settings'}
] as const;

export type NavigationItem = (typeof navigationItems)[number];
export type NavigationKey = NavigationItem['key'];

const mobilePrimaryKeys = new Set<NavigationKey>(['home', 'calls', 'bookings', 'orders']);

export function splitMobileNavigation(items: readonly NavigationItem[] = navigationItems) {
  return {
    primary: items.filter((item) => mobilePrimaryKeys.has(item.key)),
    more: items.filter((item) => !mobilePrimaryKeys.has(item.key))
  };
}
