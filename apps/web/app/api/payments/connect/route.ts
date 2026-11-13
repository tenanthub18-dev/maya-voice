import {paymentConnectDependencies} from './_default';
import {createPaymentConnectHandler} from './_lib';

export function GET(request: Request): Promise<Response> {
  return createPaymentConnectHandler(paymentConnectDependencies()).GET(request);
}

export function POST(request: Request): Promise<Response> {
  return createPaymentConnectHandler(paymentConnectDependencies()).POST(request);
}

export function DELETE(request: Request): Promise<Response> {
  return createPaymentConnectHandler(paymentConnectDependencies()).DELETE(request);
}
