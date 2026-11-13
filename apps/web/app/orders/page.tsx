import {OrdersScreen} from '@/components/orders-screen';

export default async function Page({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  return <OrdersScreen searchParams={await searchParams}/>;
}
