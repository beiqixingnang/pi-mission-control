# 成员目标完成提交（2026-10-29）

长任务中的成员现在可以逐个或批量提交已经完成的已分配目标，而不结束当前任务，也不等待主模型确认。提交绑定目标 ID、当前 revision、结果摘要和可选的每条验收标准证据路径；目标进入“待验收”，但没有自动验收。

成员工具是 `goal_submit`：

```json
{
  "submissions": [
    {
      "goalId": "child-goal-id",
      "revision": 0,
      "summary": "完成该小节并保存了可复核结果。",
      "evidence": [
        {
          "criterion": 1,
          "summary": "对应检查已通过。",
          "path": "reports/child-result.txt"
        }
      ]
    }
  ]
}
```

一次调用最多提交 50 个已分配目标。当前任务继续运行，提交不会触发主模型即时唤醒；提交记录会进入 lead 的持久消息箱，按原有通知策略和定时汇报读取。成员可以重新提交以替换同一目标当前提交，也可以用 `withdrawGoalIds` 撤回当前提交后继续修改。历史提交保持可查。

主模型用 `goal_tree(goalId, section:"submissions")` 分页查看提交和历史。检查结果后，将提交中的证据映射为 `goal_accept` 的 `source:"submission"`，提供 `submissionId`；验收仍要求任务收束、当前 revision、全部验收标准和已有目标依赖满足。提交不会改变 criteria、scope、goal revision、预算或成员权限。

提交权限由当前成员执行令牌和任务绑定决定：只能提交当前执行已分配的目标，过时 revision、跨主目标、关闭目标、重复目标和旧令牌均被拒绝。代码变更导致目标 revision 更新时，旧提交不再可被验收；目标编辑、重载、迁移和会话恢复保留提交历史。提交状态、待验收面板和目标详情均来自同一 SQLite 账本。

回归覆盖单目标提交、50目标批次边界、持续执行、静默唤醒、撤回、重新提交、历史 superseded、精确 assignment/revision/令牌校验、路径证据、lead 验收、任务未收束时拒绝验收、reload 保留、目标详情分页，以及真实 Pi 成员工具调用。
