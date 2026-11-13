import type {Booking, Call, Message, Order} from './data/types';

export function buildHomeStats(calls: Call[], bookings: Booking[], orders: Order[], messages: Message[], today: string) {
  return {
    calls: calls.filter((call) => call.startedAt.startsWith(today)).length,
    bookings: bookings.filter((booking) => booking.startsAt.startsWith(today)).length,
    orders: orders.filter((order) => order.pickupAt.startsWith(today)).length,
    messages: messages.filter((message) => message.createdAt.startsWith(today) && !message.handled).length
  };
}

export function groupOrdersByStatus(orders: Order[]) {
  return {
    new: orders.filter((order) => order.status === 'new'),
    'in-progress': orders.filter((order) => order.status === 'in-progress'),
    ready: orders.filter((order) => order.status === 'ready')
  };
}
