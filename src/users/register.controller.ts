import { Controller, Post, Body } from '@nestjs/common';
import { UsersService, RegisterUserDto } from './users.service';

/**
 * Registro de usuarios protegido por ADMIN_SETUP_KEY (no requiere sesión).
 * Se usa desde una página de registro oculta en el frontend; no está enlazado
 * en ninguna parte de la app. La seguridad la da la clave de configuración.
 */
@Controller('register')
export class RegisterController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  register(@Body() dto: RegisterUserDto) {
    return this.usersService.registerUser(dto);
  }
}
