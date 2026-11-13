function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

export const webProfile = freeze({
  id: 'library-web-v1',
  task: {
    id: 'library-web-v1',
    title: '具备真实 SQLite 持久化与角色权限的图书借阅 Web 应用',
    implementation: '只实现本任务业务，不输出命令、可信 passed 或测试完成声明。使用 Node.js 内置模块，无外部依赖、Shell、子进程、外部网络或监听端口。平台拥有 package/server/.platform 入口，候选只能提交允许的源码文件。',
    interface: 'src/app.mjs 导出 async createApp({databasePath})，返回 {handle,close?}。handle({method,path,headers,body:string}) 返回或异步返回 {status,headers,body:string|Buffer}。stdout 为平台专用协议，不得 console.log 或 process.stdout.write；必要错误仅有限 stderr。必须只用传入 databasePath 打开真实 SQLite；close 应关闭数据库。',
    accounts: [{ id: 'admin', username: 'admin', password: 'admin-pass', role: 'admin' }, { id: 'alice', username: 'alice', password: 'alice-pass', role: 'member' }, { id: 'bob', username: 'bob', password: 'bob-pass', role: 'member' }],
    initialBooks: [{ id: 'book-1', title: '课程示例图书', copies: 1 }],
    routes: [
      'POST /api/login {username,password} => 200 {user:{id,role}}；错误凭据401；设置非空 app_session Cookie，HttpOnly、Path=/、SameSite=Lax。',
      'POST /api/logout => 200 {ok:true}；清除 Cookie 并使旧会话失效。GET /api/me => 200 {user:{id,role}}，未登录401。',
      'GET /api/books（需登录）=> 200 {books:[{id,title,copies,available}]}。',
      'POST /api/books（仅admin）{title,copies} => 201 {book}，book含id/title/copies/available；title去首尾空白后1至120字符；copies为1至1000整数，初始available等于copies。',
      'POST /api/loans（需登录）{bookId} => 201 {loan:{id,bookId,userId,status:"active"}}；同用户同书至多一条active，重复或库存不足409，不存在图书404。',
      'GET /api/loans => 200 {loans}；member只见自己的全部记录，admin见所有记录。',
      'POST /api/loans/:id/return（owner/admin）=> 200 {loan}，status为returned；重复归还409，不存在404，其他member403。',
      'GET /api/audit（仅admin）=> 200 {events:[{action:"borrow"|"return"|"create_book",actorId,targetId,at}]}。create_book目标为bookId，borrow/return目标为loanId。at为ISO时间，actorId取实际会话。',
    ],
    invariants: [
      '所有API统一JSON，错误体为{error:非空字符串}；输入非法400、未登录401、越权403、不存在404、状态或库存冲突409。',
      '服务端校验权限与所有权，不能信任输入中的userId/actorId/role。额外的归属或权限字段必须400；所有非法操作保持业务数据和审计不变。',
      'copies为总库存，available=copies-active借阅数，始终0<=available<=copies。两用户并发竞争最后一本时恰好一人201，另一人409。',
      '每次成功新增图书、借阅、归还恰好追加对应审计；失败操作不追加。初始数据只初始化一次。',
      '重启复用同一databasePath，图书、借还和审计完整保留；不要求会话跨重启保留，允许重新登录。',
    ],
    database: { engine: 'node:sqlite DatabaseSync', tables: { books: ['id', 'title', 'copies'], loans: ['id', 'book_id', 'user_id', 'status'], audit_events: ['action', 'actor_id', 'target_id', 'at'] }, rule: '以上必须是真实普通表，可增加字段和其他表；列语义与API一致，平台独立只读观察。' },
    frontend: 'GET / 返回原生HTML（Content-Type:text/html），含用户名/密码登录表单（input name=username/password）、图书借阅、我的借阅归还、管理员新增图书与审计。所有JS/CSS为public中的同源外部文件并以script src和link rel=stylesheet引用；禁止内联script/style、on*事件属性、style属性、外部CDN。必须可GET访问资源并返回正确内容类型。平台CSP只允许self。前端须实际调用上述API并展示错误，HTTP静态检查不代替最终浏览器操作。',
    browserSelectors: '使用data-testid：login-username（有标签的input）、login-password（有标签且type=password）、login-submit、logout；book-list，图书行book-<id>及按钮borrow-<id>（book-1对应book-book-1/borrow-book-1）；my-loans，借阅行loan-<id>及按钮return-<loanId>；admin-book-title、admin-book-copies、admin-book-submit；audit-list以纯文本保留各event的action/actorId/targetId原值，可附中文说明，不强制单项id。登录后直接显示图书和本人记录；admin还直接显示新增表单与审计。',
  },
});
