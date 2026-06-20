# CQRS 온보딩 가이드 — "안 했을 때 vs 했을 때"

> 이 문서 하나만 읽으면 우리 프로젝트가 **왜 CQRS로 짜여 있는지**, 안 썼다면 어떻게 달라지는지,
> 언제 넘어가는 게 이득인지, 그리고 **테스트가 어떻게 쉬워지는지**까지 전부 이해된다.
> 사전 지식 없어도 따라올 수 있게 처음부터 차근차근 간다.

---

## 0. 30초 요약 (바쁜 사람용)

| | CQRS 안 함 (Service 방식) | CQRS 함 (지금 우리 코드) |
|---|---|---|
| 핵심 구조 | `Controller → Service → Repository` | `Controller → CommandBus → Handler → Repository` |
| 동작 1개당 | Service의 메서드 1개 | `Command` 1개 + `Handler` 1개 |
| 장점 | 단순, 파일 적음, 추적 쉬움 | 책임 분리, 확장 쉬움, 읽기/쓰기 따로 최적화 |
| 단점 | 커지면 God Service, 읽기/쓰기 한 모델에 묶임 | 보일러플레이트 많음, 간접 단계로 추적 어려움 |
| 적합 | 단순 CRUD, 작은 서비스 | 복잡한 도메인, 읽기≫쓰기, 이벤트 많은 시스템 |

**결론 미리보기:** 단순 CRUD면 Service가 맞다. 도메인이 복잡해지거나 읽기/쓰기 부하가 비대칭이면 CQRS가 빛난다.
지금 프로젝트는 *학습/패턴 연습 + 미래 확장 대비*라서 CQRS를 깔아둔 것이다.

---

## 1. 먼저 용어부터 (모른다고 가정)

### CQRS = Command Query Responsibility Segregation

번역하면 **"명령과 조회의 책임을 분리한다"**. 딱 두 단어만 기억하면 된다.

- **Command (명령)** = 시스템의 **상태를 바꾸는** 요청. "상품을 만들어라", "재고를 줄여라", "비활성화해라".
  - 데이터를 **쓴다(write)**. 보통 리턴값이 없거나 최소한이다.
- **Query (조회)** = 시스템의 **상태를 읽기만** 하는 요청. "상품 목록 줘", "이 상품 상세 줘".
  - 데이터를 **읽는다(read)**. 절대 상태를 바꾸지 않는다.

> 핵심 통찰: **"쓰기"와 "읽기"는 성격이 완전히 다르다.**
> - 쓰기는 *규칙 검증*이 중요하다 (가격이 음수면 안 됨, SKU 형식 맞아야 함...).
> - 읽기는 *빠르고 보기 좋은 모양*이 중요하다 (여러 테이블 조인해서 한 방에).
>
> 그런데 전통적인 방식은 이 둘을 **같은 모델**로 처리한다. CQRS는 이걸 갈라놓자는 것이다.

### Handler / Bus 가 뭔데?

- **Handler (핸들러)** = 하나의 Command를 실제로 처리하는 클래스. "상품 생성"이라는 명령 1개당 핸들러 1개.
- **Bus (버스)** = "이 명령 처리해줘"라고 던지면, **알아서 맞는 핸들러를 찾아 실행해주는** 우체국 같은 존재.
  - Controller는 *누가* 처리하는지 몰라도 된다. 그냥 `commandBus.execute(명령)` 하면 끝.
  - 이 "누가 처리하는지 모름"이 나중에 큰 장점이 된다 (뒤에서 설명).

---

## 2. 우리 도메인부터 보고 가자

설명을 우리 실제 코드로 할 거라서, 먼저 주인공인 `Product`를 짚는다.

```ts
// src/product/domain/entities/product.entity.ts
export class Product extends AggregateRoot {
  private _id: ProductId;
  private _name: string;
  private _price: Money;
  private _sku: Sku;
  private _stock: number;
  // ...

  // 새 상품 만들 때 — 검증 후 생성
  static create(
    name: string, description: string, sku: string,
    price: number, currency: string, stock: number,
  ) {
    Product.validateName(name);
    Product.validateStock(stock);
    return new Product({
      id: new ProductId(),
      name, description,
      sku: Sku.create(sku),           // SKU 형식 검증은 VO가 책임
      price: Money.create(price, currency), // 음수/통화 검증은 Money가 책임
      stock, isActive: true, lowStockThreshold: 5,
      createdAt: new Date(), updatedAt: new Date(),
    });
  }

  // DB에서 불러온 데이터를 다시 객체로 복원할 때 (검증 안 함)
  static reconstitute(props: ProductProps): Product {
    return new Product(props);
  }
}
```

여기서 중요한 점: **비즈니스 규칙(검증)은 이미 도메인 객체 안에 다 들어있다.**
CQRS냐 아니냐는 이 도메인 *바깥*, 즉 "이 도메인을 어떻게 호출하느냐"의 문제다.
**도메인은 그대로 두고, 호출 방식만 바뀐다**는 걸 기억하자.

---

## 3. CQRS "안 했을 때" — 전통적인 Service 방식

가장 흔하고 직관적인 방식부터 보자. 이게 베이스라인이다.

### 3-1. 구조

```
Controller  →  ProductService  →  ProductRepository
 (HTTP)          (비즈니스 흐름)        (DB 저장)
```

### 3-2. 코드 (만약 이렇게 짰다면)

```ts
// product.service.ts  ← CQRS 안 쓰면 이런 파일 하나로 다 처리
@Injectable()
export class ProductService {
  constructor(
    @Inject(PRODUCT_REPOSITORY)
    private readonly repo: ProductRepository,
  ) {}

  // 쓰기
  async create(dto: CreateProductDto): Promise<Product> {
    const product = Product.create(
      dto.name, dto.description, dto.sku,
      dto.price, dto.currency ?? 'USD', dto.stock,
    );
    await this.repo.save(product);
    return product;
  }

  // 읽기
  async findOne(id: string): Promise<Product | null> {
    return this.repo.findById(new ProductId(id));
  }

  async findAll(filters: ProductFilters): Promise<Product[]> {
    return this.repo.findAll(filters);
  }

  // ...시간이 지나면 여기에 update, deactivate, decreaseStock, restock...
  // 메서드가 계속 쌓인다.
}
```

```ts
// product.controller.ts
@Controller('products')
export class ProductsController {
  constructor(private readonly service: ProductService) {}

  @Post()
  async create(@Body() dto: CreateProductDto): Promise<ProductResponseDto> {
    const product = await this.service.create(dto);
    return ProductResponseDto.fromDomain(product);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<ProductResponseDto> {
    const product = await this.service.findOne(id);
    if (!product) throw new NotFoundException();
    return ProductResponseDto.fromDomain(product);
  }
}
```

### 3-3. 이 방식의 장점 ✅

1. **직관적이다.** Controller가 `service.create()`를 부른다. 코드 읽다가 "정의로 이동" 누르면 바로 구현으로 점프한다. 흐름이 한눈에 보인다.
2. **파일이 적다.** 동작 5개여도 `ProductService` 파일 하나.
3. **러닝커브 없음.** 신입도 30분이면 이해한다.

### 3-4. 이 방식의 단점 ❌

1. **God Service 문제.** 서비스가 커지면 `ProductService`에 메서드가 20~30개씩 쌓인다.
   create, update, delete, deactivate, decreaseStock, restock, applyDiscount, changePrice...
   한 파일이 800줄이 되고, 서로 다른 책임이 한 클래스에 엉킨다.
2. **읽기와 쓰기가 같은 모델에 묶인다.** `findAll`로 화면에 뿌릴 땐 "카테고리명, 리뷰 평점, 재고상태 라벨"까지 조인해서 주고 싶은데,
   쓰기용 `Product` 도메인 모델엔 그런 게 없다. 그래서 억지로 도메인을 부풀리거나, 서비스에서 변환 코드가 지저분해진다.
3. **횡단 관심사(로깅/트랜잭션/권한) 끼우기 번거롭다.** 매 메서드마다 직접 넣거나 데코레이터를 붙여야 한다.

> 핵심: **작을 땐 문제없다. 커지면 1·2·3번이 동시에 터진다.**

---

## 4. CQRS "했을 때" — 지금 우리 코드

이제 같은 기능을 CQRS로. 우리 프로젝트가 실제로 이렇게 되어 있다.

### 4-1. 구조

```
Controller → CommandBus → CreateProductHandler → ProductRepository
                 │
                 └ "CreateProductCommand 처리할 핸들러 찾아서 실행해줘"
```

### 4-2. 코드 (실제 우리 파일들)

**① Command — "무엇을 해달라"는 요청을 담은 데이터 봉투**

```ts
// src/product/application/use-cases/create-product/create-product.command.ts
export class CreateProductCommand {
  constructor(
    public readonly name: string,
    public readonly description: string,
    public readonly sku: string,
    public readonly price: number,
    public readonly currency: string,
    public readonly stock: number,
  ) {}
}
```
> Command는 **로직이 없다.** 그냥 "이 값들로 상품을 만들어줘"라는 *의도 + 데이터*만 담은 불변 객체다.
> 편지 봉투라고 생각하면 된다. 내용물(데이터)만 있고, 일은 안 한다.

**② Handler — 그 명령을 실제로 처리하는 일꾼**

```ts
// src/product/application/use-cases/create-product/create-product.handler.ts
@CommandHandler(CreateProductCommand)   // "나는 이 명령을 처리하는 담당자야"라고 등록
export class CreateProductHandler
  implements ICommandHandler<CreateProductCommand>
{
  constructor(
    @Inject(PRODUCT_REPOSITORY)
    private readonly productRepository: ProductRepository, // 인터페이스에만 의존!
  ) {}

  async execute(command: CreateProductCommand): Promise<void> {
    const product = Product.create(
      command.name, command.description, command.sku,
      command.price, command.currency, command.stock,
    );
    await this.productRepository.save(product);
  }
}
```
> 핸들러 하나 = 유스케이스 하나. "상품 생성"이라는 단 하나의 책임만 진다.
> `import type { ProductRepository }`로 **인터페이스(포트)에만 의존**하고, 실제 DB 구현체는 모른다. (이게 테스트에서 결정적 이득 — 6장에서)

**③ Controller — HTTP를 받아 Command로 바꿔 버스에 던진다**

```ts
// src/product/presentation/product.controller.ts
@Controller('products')
export class ProductsController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post()
  async create(@Body() dto: CreateProductDto): Promise<ProductResponseDto> {
    const product = await this.commandBus.execute<CreateProductCommand, Product>(
      new CreateProductCommand(
        dto.name, dto.description, dto.sku,
        dto.price, dto.currency || 'USD', dto.stock,
      ),
    );
    return ProductResponseDto.fromDomain(product);
  }
}
```
> Controller는 `CreateProductHandler`라는 이름조차 모른다. 그냥 명령을 버스에 던질 뿐.
> **"누가 처리하는지 모름" = 느슨한 결합(loose coupling)**. 나중에 핸들러를 바꿔치기해도 컨트롤러는 손 안 댄다.

### 4-3. 흐름 한 장으로

```
[HTTP POST /products]
        │
        ▼
  ProductsController         dto → Command 변환
        │  commandBus.execute(new CreateProductCommand(...))
        ▼
  CommandBus                "이 명령 담당자 누구?" → CreateProductHandler 발견
        │
        ▼
  CreateProductHandler       Product.create() 로 도메인 생성 + 검증
        │
        ▼
  ProductRepository(포트)     save(product)  ← 인터페이스
        │
        ▼
  DrizzleProductRepository    실제 Postgres INSERT  ← 구현체(어댑터)
```

---

## 5. 진짜 핵심 — "읽기/쓰기 분리"가 왜 강력한가

3장에서 "CQRS 안 쓰면 읽기/쓰기가 한 모델에 묶인다"고 했다. 이게 CQRS의 **진짜 존재 이유**다.
앞의 create 예시만 보면 "파일만 늘었네?" 싶다. 맞다. **쓰기만 보면 손해다.** 읽기까지 봐야 그림이 완성된다.

### 5-1. 문제 상황

상품 목록 화면을 만든다고 하자. 화면에 필요한 건:

```
상품명 | 가격 | 재고상태("품절"/"부족"/"충분") | 카테고리명 | 평균 리뷰점수
```

그런데 쓰기용 `Product` 도메인 모델엔 `재고상태 라벨`도, `카테고리명`도, `리뷰점수`도 없다.
그건 다른 테이블(category, review)에 있거나 계산해야 하는 값이다.

**CQRS 안 쓰면?** → 도메인 모델 `Product`를 억지로 부풀리거나, 서비스에서 N번 조회해서 조합한다. 지저분해진다.

### 5-2. CQRS의 해법 — 읽기 전용 모델을 따로 둔다

쓰기는 도메인 모델(`Product`)로, **읽기는 화면에 딱 맞는 별도 모델(Read Model)**로 처리한다.

```ts
// Query — "목록 줘"라는 조회 요청
export class ListProductsQuery {
  constructor(
    public readonly isActive?: boolean,
    public readonly page: number = 1,
  ) {}
}
```

```ts
// 읽기 전용 결과 모델 — 화면 모양 그대로. 도메인 규칙 따위 없음.
export interface ProductListItemView {
  id: string;
  name: string;
  price: number;
  stockStatus: 'OUT_OF_STOCK' | 'LOW' | 'IN_STOCK';
  categoryName: string;
  averageRating: number;
}
```

```ts
// Query Handler — 도메인 거치지 않고 DB에서 화면용으로 바로 조인해서 가져옴
@QueryHandler(ListProductsQuery)
export class ListProductsHandler
  implements IQueryHandler<ListProductsQuery, ProductListItemView[]>
{
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async execute(query: ListProductsQuery): Promise<ProductListItemView[]> {
    // 도메인 객체로 복원할 필요 없음! 그냥 화면용 SQL 조인 한 방.
    return this.db
      .select({
        id: products.id,
        name: products.name,
        price: products.price,
        stockStatus: sql`CASE WHEN stock = 0 THEN 'OUT_OF_STOCK'
                              WHEN stock < low_stock_threshold THEN 'LOW'
                              ELSE 'IN_STOCK' END`,
        categoryName: categories.name,
        averageRating: sql`COALESCE(AVG(reviews.rating), 0)`,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .leftJoin(reviews, eq(reviews.productId, products.id))
      .where(query.isActive != null ? eq(products.isActive, query.isActive) : undefined)
      .groupBy(products.id, categories.name);
  }
}
```

### 5-3. 무엇이 좋아졌나

| | 쓰기 (Command) | 읽기 (Query) |
|---|---|---|
| 목적 | 규칙을 지키며 안전하게 저장 | 빠르게, 화면 모양대로 |
| 거치는 것 | `Product` 도메인 객체 (검증 O) | 도메인 안 거침. SQL 직빵 |
| 모델 | 정규화된 도메인 모델 | 화면에 맞춘 평평한 뷰 |
| 최적화 방향 | 무결성 | 속도 (조인/캐시/인덱스/심지어 별도 DB) |

> **이게 CQRS의 본질이다.** 쓰기는 "안전"이, 읽기는 "속도와 모양"이 중요한데,
> 둘을 **각자 최적화**할 수 있게 길을 갈라놓는 것. 극단적으로 가면 읽기는 아예 별도 DB(Elasticsearch, Redis, 읽기 전용 복제본)를 쓰기도 한다.

### 5-4. 부하 비대칭 — 숫자로 느끼기

쇼핑몰을 예로 들면:
- 상품 **조회**: 초당 10,000건 (사람들이 구경)
- 상품 **생성/수정**: 하루 100건 (운영자가 등록)

읽기가 쓰기보다 **수만 배** 많다. CQRS면 읽기 쪽만 캐시/복제본으로 독립적으로 확장(scale-out)할 수 있다.
한 모델에 묶여 있으면 이게 안 된다. **이 비대칭이 클수록 CQRS 이득이 커진다.**

---

## 6. 테스트 코드 관점 — 여기서 CQRS가 진짜 빛난다

(요청대로 길게 간다. 테스트야말로 CQRS의 숨은 최대 장점이다.)

### 6-1. 왜 테스트가 쉬워지나 — 의존성이 좁다

핸들러를 다시 보자.

```ts
export class CreateProductHandler {
  constructor(
    @Inject(PRODUCT_REPOSITORY)
    private readonly productRepository: ProductRepository, // ← 의존성 단 1개, 그것도 인터페이스
  ) {}
  async execute(command: CreateProductCommand): Promise<void> { /* ... */ }
}
```

- 의존성이 **`ProductRepository` 인터페이스 하나뿐**이다.
- HTTP도, DB도, 프레임워크도 모른다. → 테스트할 때 **가짜 repository 하나만 끼우면 끝**.
- 입력은 `Command`(순수 데이터), 출력도 명확. → **순수 함수에 가까운 테스트**가 된다.

### 6-2. 핸들러 단위 테스트 (실DB 없이)

```ts
// create-product.handler.spec.ts
describe('CreateProductHandler', () => {
  let handler: CreateProductHandler;
  let repo: jest.Mocked<ProductRepository>;

  beforeEach(() => {
    // 가짜 repository — 진짜 DB 필요 없음
    repo = {
      save: jest.fn(),
      findById: jest.fn(),
      findAll: jest.fn(),
    };
    handler = new CreateProductHandler(repo); // new 한 줄로 끝. Nest은 안 띄워도 됨
  });

  it('유효한 명령이면 상품을 저장한다', async () => {
    const command = new CreateProductCommand(
      'Keyboard', '기계식 키보드', 'KB-001', 100, 'USD', 10,
    );

    await handler.execute(command);

    // repository.save가 정확히 1번, Product 인스턴스로 불렸는지 검증
    expect(repo.save).toHaveBeenCalledTimes(1);
    const saved = repo.save.mock.calls[0][0];
    expect(saved).toBeInstanceOf(Product);
    expect(saved.name).toBe('Keyboard');
    expect(saved.price.getAmount()).toBe(100);
    expect(saved.sku.getValue()).toBe('KB-001'); // VO가 대문자 정규화까지
  });

  it('이름이 2자 미만이면 예외를 던지고 저장하지 않는다', async () => {
    const command = new CreateProductCommand(
      'K', '설명', 'KB-001', 100, 'USD', 10,
    );

    await expect(handler.execute(command)).rejects.toThrow(
      'Name must be at least 2 characters long',
    );
    expect(repo.save).not.toHaveBeenCalled(); // 검증 실패 시 저장 안 됨을 보장
  });

  it('재고가 음수면 예외를 던진다', async () => {
    const command = new CreateProductCommand(
      'Keyboard', '설명', 'KB-001', 100, 'USD', -5,
    );
    await expect(handler.execute(command)).rejects.toThrow(
      'Stock cannot be negative',
    );
  });
});
```

> 포인트:
> - **NestJS 모듈을 안 띄운다.** `new CreateProductHandler(repo)` 한 줄. → 테스트가 밀리초 단위로 빠르다.
> - **DB 안 띄운다.** 가짜 repo면 충분. → CI에서 Postgres 컨테이너 없이도 돈다.
> - 한 핸들러 = 한 유스케이스라서 **테스트 파일도 유스케이스 단위로 딱 떨어진다.** "이 테스트는 상품 생성만 본다"가 명확.

### 6-3. CQRS 안 썼다면 테스트는?

`ProductService`에 메서드 20개가 있으면:
- `product.service.spec.ts` 한 파일에 create/update/delete/findAll... 테스트가 **다 뭉친다.** 수백 줄.
- 서비스가 의존성을 여러 개 들고 있으면(repo + 이벤트발행 + 캐시 + 알림...) **그걸 다 mock** 해야 create 하나 테스트할 수 있다.
- "이 메서드만 보고 싶은데" 다른 의존성 셋업까지 강제된다.

즉 **CQRS는 의존성을 유스케이스 단위로 잘게 쪼개서, 테스트도 잘게 쪼개진다.** 격리가 좋아진다.

### 6-4. 읽기(Query) 테스트는 성격이 다르다 — 일부러 통합테스트로

쓰기 핸들러는 가짜 repo로 단위 테스트가 좋지만, 읽기 핸들러는 **SQL 조인 자체가 핵심**이라 가짜로 검증하면 의미가 없다.
그래서 읽기는 **실제 DB를 띄운 통합 테스트**가 어울린다. (Testcontainers 등)

```ts
// list-products.handler.int-spec.ts (통합 테스트)
describe('ListProductsHandler (통합)', () => {
  let db: DrizzleDB;
  let handler: ListProductsHandler;

  beforeAll(async () => {
    db = await setupTestPostgres();   // 테스트용 실제 Postgres (Testcontainers 등)
    handler = new ListProductsHandler(db);
  });
  afterAll(() => teardownTestPostgres());

  it('재고 0이면 stockStatus가 OUT_OF_STOCK', async () => {
    await seed(db, { name: 'Pen', stock: 0, lowStockThreshold: 5 });

    const result = await handler.execute(new ListProductsQuery());

    expect(result[0].stockStatus).toBe('OUT_OF_STOCK'); // SQL CASE 로직 실제 검증
  });
});
```

> **테스트 전략이 읽기/쓰기로 자연스럽게 갈린다는 게 CQRS의 또 다른 선물이다:**
> - 쓰기(Command) = 비즈니스 규칙 → **빠른 단위 테스트** (가짜 repo)
> - 읽기(Query) = SQL 정확성 → **통합 테스트** (실제 DB)
>
> 한 덩어리 Service였다면 이 구분이 흐릿해진다.

### 6-5. 테스트 피라미드로 정리

```
        ┌─────────────┐
        │   E2E (소수)  │  Controller → Bus → Handler → 실DB, HTTP까지
        ├─────────────┤
        │ 통합 (중간)    │  Query Handler + 실DB (SQL 검증)
        ├─────────────┤
        │ 단위 (다수)    │  Command Handler + 가짜 repo (규칙 검증)  ← CQRS가 여기를 두껍게 해줌
        └─────────────┘
```

가장 많아야 할 **단위 테스트가 CQRS 구조에서 가장 쓰기 쉬워진다.** 이게 테스트 관점의 핵심 결론.

---

## 7. 언제 CQRS로 넘어가는 게 좋은가 (의사결정 가이드)

"무조건 CQRS"는 틀렸고, "무조건 Service"도 틀렸다. **신호를 보고 판단**한다.

### 7-1. 아직 Service로 충분한 신호 🟢

- 거의 **단순 CRUD**다 (만들고, 읽고, 수정하고, 지운다 — 특별한 규칙 적음).
- 읽기와 쓰기가 **같은 모양**이면 충분하다 (화면이 도메인 모델 그대로여도 OK).
- 팀이 작고, 도메인이 단순하고, 트래픽이 평범하다.
- → **이때 CQRS는 비용만 내고 이득은 없다. 가지 마라.**

### 7-2. CQRS로 넘어갈 때가 된 신호 🔴

하나라도 강하게 해당되면 진지하게 고려:

1. **읽기 ≫ 쓰기 부하 비대칭.** 조회는 폭주, 수정은 가끔. 읽기만 따로 확장하고 싶다.
2. **읽기 모델 ≠ 쓰기 모델.** 화면용 데이터가 여러 테이블 조인/계산이라 도메인 모델과 안 맞는다.
3. **God Service 징후.** `ProductService`가 500줄 넘고 메서드 20개+, 책임이 뒤엉킨다.
4. **유스케이스마다 사이드이펙트가 많다.** "생성 후 이벤트 발행 → 검색색인 → 알림 → 감사로그". 한 흐름에 끼울 게 많다.
5. **횡단 관심사를 한 곳에서 처리하고 싶다.** 트랜잭션/로깅/권한을 버스 미들웨어로 일괄 적용.
6. **이벤트 소싱/감사 추적이 필요하다.** "누가 언제 무엇을 했나"를 명령 단위로 기록.

### 7-3. 점진적 이행 — 전부 바꿀 필요 없다

CQRS는 **all-or-nothing이 아니다.** 우리 NestJS `CqrsModule`은 Command/Query를 *기능 단위로* 도입할 수 있다.

> **현실적인 추천 경로:**
> 1. **쓰기는 일단 Service로** 둬도 된다 (단순하면).
> 2. 그런데 **읽기 모델이 복잡해지기 시작하면 → Query 쪽부터 CQRS 도입** (조회 전용 Read Model + QueryHandler).
> 3. 쓰기 쪽에 사이드이펙트/규칙이 불어나면 → 그때 Command 도입.
>
> 즉 보통 **"읽기 CQRS"부터** 들어가는 게 가성비가 좋다. 부하도 읽기가 크고, 모델 불일치도 읽기에서 먼저 터지니까.

### 7-4. 한 줄 판단 기준

> **"읽기와 쓰기를 따로 최적화할 이유가 생겼는가?"**
> → YES면 CQRS. NO면 Service. 이게 전부다.

---

## 8. 흔한 오해 바로잡기

| 오해 | 진실 |
|---|---|
| "CQRS 쓰면 무조건 DB를 2개 써야 한다" | 아니다. 같은 DB로도 가능. 모델/경로만 분리해도 CQRS다. 별도 DB는 극단적 선택지일 뿐. |
| "CQRS = 이벤트 소싱" | 다른 개념이다. 자주 같이 쓰일 뿐, CQRS는 이벤트 소싱 없이도 한다. |
| "CQRS면 항상 메시지 큐/비동기" | 아니다. 우리 코드처럼 동기 `commandBus.execute()`로도 충분. |
| "CQRS가 더 우월한 아키텍처다" | 아니다. **상황에 맞으면** 우월. 단순 CRUD엔 그냥 무거운 짐이다. |
| "도메인 로직을 핸들러에 넣어야지" | 아니다. 로직은 **도메인(`Product`)에**. 핸들러는 *조율(orchestration)*만 한다. 우리 핸들러가 `Product.create()`를 호출만 하는 이유. |

---

## 9. 우리 프로젝트는 지금 어디쯤인가

- 현재: 쓰기 경로(Create)에 CQRS를 **이미 깔아둔** 상태. 읽기 전용 Read Model은 아직 없음.
- 솔직한 평가: *지금 기능만 보면* 단순 create라서 CQRS 이득(읽기/쓰기 분리)을 아직 안 쓰고 있다 → **현재는 학습/확장 대비 비용**을 내는 중.
- 합리적인 이유: 이 레포 이름이 `clean-architecture`다. **DDD/CQRS 패턴 연습 + 앞으로 도메인 복잡해질 대비**가 목적이라면 지금 구조는 타당하다.
- 다음 스텝 추천:
  1. 읽기가 필요해지면 `ListProductsQuery` + Read Model부터 추가해서 **CQRS의 진짜 이점(5장)을 체감**해보기.
  2. 핸들러마다 단위 테스트(6장) 붙여서 **격리된 테스트의 쾌감**을 경험하기.
  3. 도메인 행위(재고 차감 `decreaseStock` 등)를 `Product`에 추가하며 **로직은 도메인에, 조율은 핸들러에** 원칙을 연습하기.

---

## 10. 최종 요약

1. **CQRS = 읽기와 쓰기를 갈라서 각자 최적화하는 패턴.** 그게 전부다.
2. **쓰기만 보면 CQRS는 손해** (파일만 늘어남). **읽기까지 봐야** 이득이 보인다 (5장).
3. **테스트가 진짜 이득** — 핸들러는 의존성이 좁아 가짜 repo 하나로 빠른 단위 테스트가 된다 (6장).
4. **언제 넘어가나** — "읽기/쓰기를 따로 최적화할 이유가 생겼는가?"가 판단 기준. 보통 **읽기 CQRS부터** 점진 도입 (7장).
5. **단순 CRUD면 Service가 정답.** CQRS는 복잡성을 다스리는 도구지, 복잡성을 *추가*하려고 쓰는 게 아니다.

> 도구는 문제에 맞춰 고른다. CQRS는 "복잡한 쓰기 규칙 + 비대칭 읽기 부하"라는 문제를 푸는 좋은 도구고,
> 그 문제가 없다면 안 쓰는 게 더 좋은 설계다. **우리 프로젝트는 그 문제가 올 것에 대비해 미리 길을 깔아둔 것**이라고 이해하면 된다.
