import { FeilianController } from "./feilian-control";

const controller = new FeilianController();

async function test() {
  console.log("1. 检查当前状态...");
  const status = await controller.checkStatus();
  console.log(controller.formatStatus(status));

  console.log("\n2. 切换 VPN 状态...");
  const result = await controller.toggle();
  console.log(result.message);
  if (result.error) {
    console.error(result.error);
  }
}

test();
