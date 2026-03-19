import { NextRequest, NextResponse } from 'next/server';

const RPC_HOST = process.env.NEXT_PUBLIC_RPC_HOST || 'http://127.0.0.1:8332';

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const authHeader = req.headers.get('authorization') || '';

    const response = await fetch(RPC_HOST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body,
    });

    const data = await response.text();
    return new NextResponse(data, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'RPC proxy error';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
