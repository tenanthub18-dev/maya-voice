import {BookingsScreen} from '@/components/bookings-screen';

export default async function Page({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  return <BookingsScreen searchParams={await searchParams}/>;
}
