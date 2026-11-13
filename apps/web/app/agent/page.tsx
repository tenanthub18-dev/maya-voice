import {AgentScreen} from '@/components/agent-screen';

export default async function Page({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  return <AgentScreen searchParams={await searchParams}/>;
}
