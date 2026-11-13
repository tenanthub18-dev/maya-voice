import {CallsScreen} from '@/components/dashboard-screen';

export default async function Page({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  return <CallsScreen searchParams={await searchParams}/>;
}
